import * as assert from 'assert'
import * as core from '@actions/core'
import {URL} from 'url'
import {IGitSourceSettings} from './git-source-settings'
import fetch from 'node-fetch'

export function getFetchUrl(settings: IGitSourceSettings): string {
  assert.ok(
    settings.repositoryOwner,
    'settings.repositoryOwner must be defined'
  )
  assert.ok(settings.repositoryName, 'settings.repositoryName must be defined')

  const serviceUrl = getServerUrl(settings.githubServerUrl)
  const encodedOwner = encodeURIComponent(settings.repositoryOwner)
  const encodedName = encodeURIComponent(settings.repositoryName)

  // SSH key takes precedence
  if (settings.sshKey) {
    const user = settings.sshUser.length > 0 ? settings.sshUser : 'git'
    const sshUrl = `${user}@${serviceUrl.hostname}:${encodedOwner}/${encodedName}.git`
    core.info(`🔑 Using SSH URL: ${sshUrl}`)
    return sshUrl
  }

  // Build HTTPS URL
  const originUrl = `${serviceUrl.origin}/${encodedOwner}/${encodedName}`

  // Apply proxy if configured
  if (settings.githubProxyUrl && settings.githubProxyUrl.trim()) {
    const proxyUrl = getProxyUrl(originUrl, settings.githubProxyUrl)

    // Enhanced logging for proxy configuration
    core.startGroup('🌐 Proxy URL Configuration')
    core.info(`Repository: ${settings.repositoryOwner}/${settings.repositoryName}`)
    core.info(`Original URL: ${originUrl}`)
    core.info(`Proxy prefix: ${settings.githubProxyUrl}`)
    core.info(`Final proxy URL: ${proxyUrl}`)
    core.info(`URL transformation: ${originUrl !== proxyUrl ? 'Applied' : 'No change'}`)
    core.endGroup()

    return proxyUrl
  }

  core.info(`📡 Using direct URL: ${originUrl}`)
  return originUrl
}

export function getServerUrl(url?: string): URL {
  let resolvedUrl = process.env['GITHUB_SERVER_URL'] || 'https://github.com'
  if (hasContent(url, WhitespaceMode.Trim)) {
    resolvedUrl = url!
  }

  return new URL(resolvedUrl)
}

export function getServerApiUrl(url?: string): string {
  if (hasContent(url, WhitespaceMode.Trim)) {
    const serverUrl = getServerUrl(url)
    if (isGhes(url)) {
      serverUrl.pathname = 'api/v3'
    } else {
      serverUrl.hostname = `api.${serverUrl.hostname}`
    }

    return pruneSuffix(serverUrl.toString(), '/')
  }

  return process.env['GITHUB_API_URL'] || 'https://api.github.com'
}

export function isGhes(url?: string): boolean {
  const ghUrl = new URL(
    url || process.env['GITHUB_SERVER_URL'] || 'https://github.com'
  )

  const hostname = ghUrl.hostname.trimEnd().toUpperCase()
  const isGitHubHost = hostname === 'GITHUB.COM'
  const isGitHubEnterpriseCloudHost = hostname.endsWith('.GHE.COM')
  const isLocalHost = hostname.endsWith('.LOCALHOST')

  return !isGitHubHost && !isGitHubEnterpriseCloudHost && !isLocalHost
}

function pruneSuffix(text: string, suffix: string) {
  if (hasContent(suffix, WhitespaceMode.Preserve) && text?.endsWith(suffix)) {
    return text.substring(0, text.length - suffix.length)
  }
  return text
}

enum WhitespaceMode {
  Trim,
  Preserve
}

function hasContent(
  text: string | undefined,
  whitespaceMode: WhitespaceMode
): boolean {
  let refinedText = text ?? ''
  if (whitespaceMode == WhitespaceMode.Trim) {
    refinedText = refinedText.trim()
  }
  return refinedText.length > 0
}

export function getProxyUrl(
  originalUrl: string,
  proxyPrefix: string | undefined
): string {
  if (!proxyPrefix || !proxyPrefix.trim()) {
    return originalUrl
  }

  const cleanPrefix = proxyPrefix.trim().replace(/\/$/, '')

  try {
    // 验证代理前缀是否为有效URL
    new URL(cleanPrefix)

    // 处理不同的代理模式
    if (cleanPrefix.includes('github.com') || cleanPrefix.includes('ghproxy')) {
      // GitHub镜像代理模式: https://ghproxy.com/https://github.com/...
      return `${cleanPrefix}/${originalUrl}`
    } else if (cleanPrefix.includes('fastgit') || cleanPrefix.includes('gitclone')) {
      // FastGit类型代理: 替换域名
      const originalUrlObj = new URL(originalUrl)
      const proxyUrlObj = new URL(cleanPrefix)
      originalUrlObj.hostname = proxyUrlObj.hostname
      if (proxyUrlObj.port) {
        originalUrlObj.port = proxyUrlObj.port
      }
      return originalUrlObj.toString()
    } else {
      // 通用代理模式: 直接拼接
      return `${cleanPrefix}/${originalUrl}`
    }
  } catch (error) {
    core.warning(`Invalid proxy URL format: ${cleanPrefix}, using original URL`)
    return originalUrl
  }
}

export function validateProxyUrl(proxyUrl: string | undefined): boolean {
  if (!proxyUrl || !proxyUrl.trim()) {
    return true // 空值是有效的（表示不使用代理）
  }

  try {
    const url = new URL(proxyUrl.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export async function testProxyConnection(
  proxyUrl: string,
  targetUrl: string = 'https://github.com',
  timeoutMs: number = 10000
): Promise<{success: boolean; error?: string; responseTime?: number}> {
  if (!validateProxyUrl(proxyUrl)) {
    return {success: false, error: 'Invalid proxy URL format'}
  }

  const startTime = Date.now()

  try {
    const testUrl = getProxyUrl(targetUrl, proxyUrl)
    core.debug(`Testing proxy connection to: ${testUrl}`)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    const response = await fetch(testUrl, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'User-Agent': 'GitHub-Actions-Checkout-Proxy-Test'
      }
    })

    clearTimeout(timeoutId)
    const responseTime = Date.now() - startTime

    if (response.ok || response.status === 403) {
      // 403 is acceptable for GitHub (rate limiting)
      return {success: true, responseTime}
    } else {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        responseTime
      }
    }
  } catch (error: any) {
    const responseTime = Date.now() - startTime

    if (error.name === 'AbortError') {
      return {
        success: false,
        error: `Connection timeout after ${timeoutMs}ms`,
        responseTime
      }
    }

    return {
      success: false,
      error: error.message || 'Unknown connection error',
      responseTime
    }
  }
}
