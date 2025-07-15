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

  // 检查是否有代理URL和代理URL中是否包含认证信息
  const hasProxyUrl = settings.githubProxyUrl && settings.githubProxyUrl.trim()
  let hasProxyAuth = false

  if (hasProxyUrl) {
    try {
      const proxyUrlObj = new URL(settings.githubProxyUrl!.trim())
      hasProxyAuth = !!(proxyUrlObj.username && proxyUrlObj.password)
    } catch (error) {
      // 如果解析失败，认为没有认证信息
      hasProxyAuth = false
    }
  }

  // 根据四种情况决定最终URL
  if (hasProxyUrl && hasProxyAuth) {
    // 情况4: 有代理URL + 代理URL中有认证 -> https://username:password@proxy.com/https://github.com/org/repo
    const finalUrl = getProxyUrlWithEmbeddedAuth(originUrl, settings.githubProxyUrl!)

    core.notice('🔄 APPLYING PROXY URL WITH EMBEDDED AUTHENTICATION')
    core.notice(`📦 Repository: ${settings.repositoryOwner}/${settings.repositoryName}`)
    core.notice(`🔗 Original URL: ${originUrl}`)
    core.notice(`🌐 Proxy prefix: ${hideUrlCredentials(settings.githubProxyUrl!)}`)
    core.notice(`🎯 Final URL: ${hideUrlCredentials(finalUrl)}`)

    return finalUrl
  } else if (hasProxyUrl && !hasProxyAuth) {
    // 情况1: 有代理URL + 代理URL中无认证 -> https://proxy.com/https://github.com/org/repo
    const proxyUrl = getProxyUrl(originUrl, settings.githubProxyUrl!)

    core.notice('🔄 APPLYING PROXY URL (NO EMBEDDED AUTH)')
    core.notice(`📦 Repository: ${settings.repositoryOwner}/${settings.repositoryName}`)
    core.notice(`🔗 Original URL: ${originUrl}`)
    core.notice(`🌐 Proxy prefix: ${settings.githubProxyUrl!}`)
    core.notice(`🎯 Final URL: ${proxyUrl}`)

    return proxyUrl
  } else if (!hasProxyUrl && settings.authToken && settings.authToken.trim()) {
    // 情况2: 无代理URL + 有settings认证 -> https://token:x-oauth-basic@github.com/org/repo
    const authUrl = addAuthToUrl(originUrl, settings.authToken!)

    core.notice('🔐 APPLYING DIRECT AUTHENTICATION (SETTINGS TOKEN)')
    core.notice(`📦 Repository: ${settings.repositoryOwner}/${settings.repositoryName}`)
    core.notice(`🔗 Original URL: ${originUrl}`)
    core.notice(`🎯 Final URL: ${hideUrlCredentials(authUrl)}`)

    return authUrl
  } else {
    // 情况3: 无代理URL + 无认证 -> https://github.com/org/repo
    core.notice(`📡 Using DIRECT connection (no proxy, no auth): ${originUrl}`)
    return originUrl
  }
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
  proxyPrefix: string
): string {
  const cleanPrefix = proxyPrefix.trim().replace(/\/$/, '')

  try {
    // 简单的代理前缀模式: https://proxy.com/https://github.com/org/repo
    const proxyUrl = `${cleanPrefix}/${originalUrl}`
    core.debug(`🔧 Proxy prefix mode: ${proxyUrl}`)
    return proxyUrl
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

/**
 * 安全地隐藏URL中的认证信息用于日志输出
 */
export function hideUrlCredentials(url: string): string {
  return url.replace(/:([^:@]+)@/, ':***@')
}

/**
 * 将认证信息添加到URL中
 */
function addAuthToUrl(url: string, authToken: string): string {
  try {
    const urlObj = new URL(url)
    urlObj.username = authToken
    urlObj.password = 'x-oauth-basic'
    return urlObj.toString()
  } catch (error) {
    core.warning(`Failed to add auth to URL: ${url}`)
    return url
  }
}

/**
 * 获取带嵌入认证的代理URL (认证信息已经在代理URL中)
 */
function getProxyUrlWithEmbeddedAuth(originalUrl: string, proxyUrl: string): string {
  try {
    const cleanProxy = proxyUrl.trim().replace(/\/$/, '')

    // 直接使用包含认证信息的代理URL
    const finalUrl = `${cleanProxy}/${originalUrl}`
    core.debug(`🔧 Using embedded auth proxy: ${hideUrlCredentials(finalUrl)}`)
    return finalUrl
  } catch (error) {
    core.warning(`Failed to create proxy URL with embedded auth: ${proxyUrl}`)
    return `${proxyUrl.replace(/\/$/, '')}/${originalUrl}`
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

    // 隐藏认证信息用于日志输出
    const safeTestUrl = hideUrlCredentials(testUrl)
    core.debug(`Testing proxy connection to: ${safeTestUrl}`)

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
