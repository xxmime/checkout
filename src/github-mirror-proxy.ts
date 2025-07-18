import * as core from '@actions/core'
import {URL} from 'url'

export interface MirrorProxyConfig {
  baseUrl: string
  timeout: number
  retries: number
  enableFallback: boolean
  supportedDomains: string[]
  authUsername?: string
  authToken?: string
}

export interface MirrorProxyInfo {
  originalUrl: string
  proxyUrl: string
  mirrorDomain: string
  isSupported: boolean
  hasAuth: boolean
}

/**
 * GitHub镜像代理服务支持
 * 支持类似 gh-proxy.com 的镜像加速服务
 */
export class GitHubMirrorProxy {
  private config: MirrorProxyConfig

  constructor(baseUrl: string, config?: Partial<MirrorProxyConfig>) {
    // 解析baseUrl中的认证信息
    const {cleanUrl, username, token} = this.parseAuthFromUrl(baseUrl)
    
    this.config = {
      baseUrl: this.normalizeBaseUrl(cleanUrl),
      timeout: 30000,
      retries: 3,
      enableFallback: true,
      supportedDomains: [
        'github.com',
        'api.github.com',
        'raw.githubusercontent.com',
        'codeload.github.com',
        'objects.githubusercontent.com'
      ],
      authUsername: username,
      authToken: token,
      ...config
    }

    const authInfo = this.config.authUsername ? ' (with auth)' : ''
    core.debug(`GitHub mirror proxy initialized: ${this.config.baseUrl}${authInfo}`)
  }

  /**
   * 将GitHub URL转换为镜像代理URL
   */
  convertToProxyUrl(originalUrl: string): MirrorProxyInfo {
    try {
      const url = new URL(originalUrl)
      const isSupported = this.isSupportedDomain(url.hostname)

      if (!isSupported) {
        return {
          originalUrl,
          proxyUrl: originalUrl,
          mirrorDomain: url.hostname,
          isSupported: false,
          hasAuth: false
        }
      }

      // 构建镜像代理URL
      // 格式: https://username:token@mirror-proxy.com/https://github.com/...
      let proxyUrl = `${this.config.baseUrl}/${originalUrl}`
      
      // 如果有认证信息，添加到URL中
      if (this.config.authUsername && this.config.authToken) {
        const baseUrlObj = new URL(this.config.baseUrl)
        baseUrlObj.username = this.config.authUsername
        baseUrlObj.password = this.config.authToken
        proxyUrl = `${baseUrlObj.toString().replace(/\/$/, '')}/${originalUrl}`
      }

      return {
        originalUrl,
        proxyUrl,
        mirrorDomain: url.hostname,
        isSupported: true,
        hasAuth: !!(this.config.authUsername && this.config.authToken)
      }

    } catch (error) {
      core.debug(`Failed to parse URL: ${originalUrl} - ${error}`)
      return {
        originalUrl,
        proxyUrl: originalUrl,
        mirrorDomain: 'unknown',
        isSupported: false,
        hasAuth: false
      }
    }
  }

  /**
   * 检查域名是否支持镜像代理
   */
  private isSupportedDomain(hostname: string): boolean {
    return this.config.supportedDomains.some(domain => 
      hostname === domain || hostname.endsWith(`.${domain}`)
    )
  }

  /**
   * 从URL中解析认证信息
   */
  private parseAuthFromUrl(baseUrl: string): {
    cleanUrl: string
    username?: string
    token?: string
  } {
    try {
      const url = new URL(baseUrl)
      const username = url.username || undefined
      const token = url.password || undefined
      
      // 创建不包含认证信息的干净URL
      url.username = ''
      url.password = ''
      const cleanUrl = url.toString()
      
      return { cleanUrl, username, token }
    } catch (error) {
      throw new Error(`Invalid mirror proxy base URL: ${baseUrl}`)
    }
  }

  /**
   * 规范化基础URL
   */
  private normalizeBaseUrl(baseUrl: string): string {
    try {
      const url = new URL(baseUrl)
      // 移除末尾的斜杠和认证信息
      url.username = ''
      url.password = ''
      return url.toString().replace(/\/$/, '')
    } catch (error) {
      throw new Error(`Invalid mirror proxy base URL: ${baseUrl}`)
    }
  }

  /**
   * 批量转换URL列表
   */
  convertUrlList(urls: string[]): MirrorProxyInfo[] {
    return urls.map(url => this.convertToProxyUrl(url))
  }

  /**
   * 检查镜像代理是否可用
   */
  async checkAvailability(): Promise<{
    available: boolean
    responseTime: number
    error?: string
  }> {
    const startTime = Date.now()
    
    try {
      const fetch = require('node-fetch')
      
      // 构建测试URL，包含认证信息（如果有）
      let testUrl = `${this.config.baseUrl}/https://api.github.com/zen`
      if (this.config.authUsername && this.config.authToken) {
        const baseUrlObj = new URL(this.config.baseUrl)
        baseUrlObj.username = this.config.authUsername
        baseUrlObj.password = this.config.authToken
        testUrl = `${baseUrlObj.toString()}/https://api.github.com/zen`
      }
      
      const response = await fetch(testUrl, {
        method: 'GET',
        timeout: this.config.timeout,
        headers: {
          'User-Agent': 'actions/checkout-mirror-test'
        }
      })

      const responseTime = Date.now() - startTime

      if (response.ok) {
        return {
          available: true,
          responseTime
        }
      } else {
        return {
          available: false,
          responseTime,
          error: `HTTP ${response.status}: ${response.statusText}`
        }
      }

    } catch (error) {
      return {
        available: false,
        responseTime: Date.now() - startTime,
        error: (error as Error).message
      }
    }
  }

  /**
   * 获取配置信息
   */
  getConfig(): Readonly<MirrorProxyConfig> {
    return Object.freeze({...this.config})
  }

  /**
   * 生成镜像代理报告
   */
  generateReport(): string {
    return `GitHub Mirror Proxy Report:
=============================

Configuration:
- Base URL: ${this.config.baseUrl}
- Timeout: ${this.config.timeout}ms
- Retries: ${this.config.retries}
- Fallback Enabled: ${this.config.enableFallback}
- Authentication: ${this.config.authUsername ? 'Enabled' : 'Disabled'}

Supported Domains:
${this.config.supportedDomains.map(domain => `- ${domain}`).join('\n')}

Generated at: ${new Date().toISOString()}`
  }
}

/**
 * 常见的GitHub镜像代理服务
 */
export const POPULAR_GITHUB_MIRRORS = {
  'gh-proxy.com': 'https://gh-proxy.com',
  'ghproxy.net': 'https://ghproxy.net',
  'github.moeyy.xyz': 'https://github.moeyy.xyz',
  'hub.fastgit.xyz': 'https://hub.fastgit.xyz',
  'download.fastgit.org': 'https://download.fastgit.org'
} as const

/**
 * 创建GitHub镜像代理实例
 */
export function createGitHubMirrorProxy(
  baseUrl: string, 
  config?: Partial<MirrorProxyConfig>
): GitHubMirrorProxy {
  return new GitHubMirrorProxy(baseUrl, config)
}

/**
 * 自动检测最佳镜像代理
 */
export async function detectBestMirror(
  mirrors: string[] = Object.values(POPULAR_GITHUB_MIRRORS),
  timeout: number = 5000
): Promise<{
  bestMirror?: string
  results: Array<{
    mirror: string
    available: boolean
    responseTime: number
    error?: string
  }>
}> {
  core.info('Detecting best GitHub mirror proxy...')
  
  const results = await Promise.allSettled(
    mirrors.map(async mirror => {
      const proxy = createGitHubMirrorProxy(mirror, { timeout })
      const result = await proxy.checkAvailability()
      
      return {
        mirror,
        available: result.available,
        responseTime: result.responseTime,
        error: result.error
      }
    })
  )

  const successfulResults = results
    .filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
    .map(result => result.value)
    .filter(result => result.available)
    .sort((a, b) => a.responseTime - b.responseTime)

  const allResults = results.map(result => 
    result.status === 'fulfilled' ? result.value : {
      mirror: 'unknown',
      available: false,
      responseTime: timeout,
      error: 'Promise rejected'
    }
  )

  const bestMirror = successfulResults.length > 0 ? successfulResults[0].mirror : undefined

  if (bestMirror) {
    core.info(`Best mirror detected: ${bestMirror} (${successfulResults[0].responseTime}ms)`)
  } else {
    core.warning('No available GitHub mirror proxy found')
  }

  return {
    bestMirror,
    results: allResults
  }
}

/**
 * 智能镜像代理选择器
 */
export class SmartMirrorSelector {
  private mirrors: string[]
  private lastDetection: Date | null = null
  private cachedBestMirror: string | null = null
  private detectionInterval: number

  constructor(
    mirrors: string[] = Object.values(POPULAR_GITHUB_MIRRORS),
    detectionInterval: number = 300000 // 5分钟
  ) {
    this.mirrors = mirrors
    this.detectionInterval = detectionInterval
  }

  /**
   * 获取最佳镜像代理
   */
  async getBestMirror(forceDetection: boolean = false): Promise<string | null> {
    const now = new Date()
    const needsDetection = forceDetection || 
      !this.lastDetection || 
      !this.cachedBestMirror ||
      (now.getTime() - this.lastDetection.getTime()) > this.detectionInterval

    if (needsDetection) {
      const detection = await detectBestMirror(this.mirrors)
      this.cachedBestMirror = detection.bestMirror || null
      this.lastDetection = now
    }

    return this.cachedBestMirror
  }

  /**
   * 添加镜像代理
   */
  addMirror(mirror: string): void {
    if (!this.mirrors.includes(mirror)) {
      this.mirrors.push(mirror)
      core.debug(`Added mirror: ${mirror}`)
    }
  }

  /**
   * 移除镜像代理
   */
  removeMirror(mirror: string): void {
    const index = this.mirrors.indexOf(mirror)
    if (index > -1) {
      this.mirrors.splice(index, 1)
      core.debug(`Removed mirror: ${mirror}`)
      
      // 如果移除的是当前最佳镜像，清除缓存
      if (this.cachedBestMirror === mirror) {
        this.cachedBestMirror = null
        this.lastDetection = null
      }
    }
  }

  /**
   * 获取所有镜像列表
   */
  getMirrors(): string[] {
    return [...this.mirrors]
  }

  /**
   * 重置缓存
   */
  resetCache(): void {
    this.cachedBestMirror = null
    this.lastDetection = null
  }
}