import * as assert from 'assert'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as github from '@actions/github'
import * as io from '@actions/io'
import * as path from 'path'
import * as retryHelper from './retry-helper'
import * as toolCache from '@actions/tool-cache'
import fetch from 'node-fetch'
import {v4 as uuid} from 'uuid'
import {getServerApiUrl} from './url-helper'
import {createGitHubMirrorProxy, detectBestMirror, POPULAR_GITHUB_MIRRORS} from './github-mirror-proxy'

const IS_WINDOWS = process.platform === 'win32'

export async function downloadRepository(
  authToken: string,
  owner: string,
  repo: string,
  ref: string,
  commit: string,
  repositoryPath: string,
  baseUrl?: string,
  proxyUrl?: string
): Promise<void> {
  // Determine the default branch
  if (!ref && !commit) {
    core.info('Determining the default branch')
    ref = await getDefaultBranch(authToken, owner, repo, baseUrl, proxyUrl)
  }

  // Download the archive
  let archiveData = await retryHelper.execute(async () => {
    core.info('Downloading the archive')
    return await downloadArchive(authToken, owner, repo, ref, commit, baseUrl, proxyUrl)
  })

  // Write archive to disk
  core.info('Writing archive to disk')
  const uniqueId = uuid()
  const archivePath = IS_WINDOWS
    ? path.join(repositoryPath, `${uniqueId}.zip`)
    : path.join(repositoryPath, `${uniqueId}.tar.gz`)
  await fs.promises.writeFile(archivePath, archiveData)
  archiveData = Buffer.from('') // Free memory

  // Extract archive
  core.info('Extracting the archive')
  const extractPath = path.join(repositoryPath, uniqueId)
  await io.mkdirP(extractPath)
  if (IS_WINDOWS) {
    await toolCache.extractZip(archivePath, extractPath)
  } else {
    await toolCache.extractTar(archivePath, extractPath)
  }
  await io.rmRF(archivePath)

  // Determine the path of the repository content. The archive contains
  // a top-level folder and the repository content is inside.
  const archiveFileNames = await fs.promises.readdir(extractPath)
  assert.ok(
    archiveFileNames.length == 1,
    'Expected exactly one directory inside archive'
  )
  const archiveVersion = archiveFileNames[0] // The top-level folder name includes the short SHA
  core.info(`Resolved version ${archiveVersion}`)
  const tempRepositoryPath = path.join(extractPath, archiveVersion)

  // Move the files
  for (const fileName of await fs.promises.readdir(tempRepositoryPath)) {
    const sourcePath = path.join(tempRepositoryPath, fileName)
    const targetPath = path.join(repositoryPath, fileName)
    if (IS_WINDOWS) {
      await io.cp(sourcePath, targetPath, {recursive: true}) // Copy on Windows (Windows Defender may have a lock)
    } else {
      await io.mv(sourcePath, targetPath)
    }
  }
  await io.rmRF(extractPath)
}

/**
 * Looks up the default branch name
 */
export async function getDefaultBranch(
  authToken: string,
  owner: string,
  repo: string,
  baseUrl?: string,
  proxyUrl?: string
): Promise<string> {
  return await retryHelper.execute(async () => {
    core.info('Retrieving the default branch name')
    
    // 如果有镜像代理配置，暂不支持API调用的镜像代理
    if (proxyUrl) {
      core.warning('Proxy configuration ignored for API calls. Only archive downloads support mirror proxy.')
    }
    
    // 原有的octokit逻辑（无代理时使用）
    const octokit = github.getOctokit(authToken, {
      baseUrl: getServerApiUrl(baseUrl)
    })
    let result: string
    try {
      // Get the default branch from the repo info
      const response = await octokit.rest.repos.get({owner, repo})
      result = response.data.default_branch
      assert.ok(result, 'default_branch cannot be empty')
    } catch (err) {
      // Handle .wiki repo
      if (
        (err as any)?.status === 404 &&
        repo.toUpperCase().endsWith('.WIKI')
      ) {
        result = 'master'
      }
      // Otherwise error
      else {
        throw err
      }
    }

    // Print the default branch
    core.info(`Default branch '${result}'`)

    // Prefix with 'refs/heads'
    if (!result.startsWith('refs/')) {
      result = `refs/heads/${result}`
    }

    return result
  })
}

async function downloadArchive(
  authToken: string,
  owner: string,
  repo: string,
  ref: string,
  commit: string,
  baseUrl?: string,
  proxyUrl?: string
): Promise<Buffer> {
  const serverUrl = getServerApiUrl(baseUrl) || 'https://api.github.com'
  const archiveFormat = IS_WINDOWS ? 'zipball' : 'tarball'
  const originalUrl = `${serverUrl}/repos/${owner}/${repo}/${archiveFormat}/${commit || ref}`
  
  // 检查是否使用GitHub镜像代理模式
  if (proxyUrl && isGitHubMirrorProxy(proxyUrl)) {
    return await downloadWithMirrorProxy(originalUrl, authToken, proxyUrl)
  }
  
  // 如果没有代理但启用了自动镜像检测
  if (!proxyUrl && process.env['GITHUB_AUTO_MIRROR'] === 'true') {
    return await downloadWithAutoMirror(originalUrl, authToken)
  }
  
  // 如果指定了非镜像代理URL，给出警告并使用直接下载
  if (proxyUrl) {
    core.warning(`Traditional proxy not supported. Use GitHub mirror proxy instead: ${proxyUrl}`)
  }
  
  // 使用直接下载
  return await downloadDirectly(originalUrl, authToken)
}

/**
 * 检查是否为GitHub镜像代理URL
 */
function isGitHubMirrorProxy(proxyUrl: string): boolean {
  try {
    const url = new URL(proxyUrl)
    // 检查是否为已知的镜像代理服务
    const knownMirrors = Object.values(POPULAR_GITHUB_MIRRORS)
    return knownMirrors.some(mirror => {
      try {
        const mirrorUrl = new URL(mirror)
        return url.hostname === mirrorUrl.hostname
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

/**
 * 使用GitHub镜像代理下载
 */
async function downloadWithMirrorProxy(
  originalUrl: string,
  authToken: string,
  proxyUrl: string
): Promise<Buffer> {
  const mirrorProxy = createGitHubMirrorProxy(proxyUrl)
  const proxyInfo = mirrorProxy.convertToProxyUrl(originalUrl)
  
  if (!proxyInfo.isSupported) {
    core.warning(`URL not supported by mirror proxy: ${originalUrl}`)
    throw new Error('URL not supported by GitHub mirror proxy')
  }

  const authInfo = proxyInfo.hasAuth ? ' (with embedded auth)' : ''
  core.info(`Using GitHub mirror proxy: ${proxyInfo.mirrorDomain}${authInfo}`)
  
  // 安全地记录代理URL（隐藏认证信息）
  const safeProxyUrl = sanitizeProxyUrl(proxyInfo.proxyUrl)
  core.debug(`Mirror proxy URL: ${safeProxyUrl}`)

  const fetch = require('node-fetch')
  
  try {
    const headers: {[key: string]: string} = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'actions/checkout'
    }

    // 如果镜像代理没有内嵌认证信息，则添加Authorization头
    if (!proxyInfo.hasAuth && authToken) {
      headers['Authorization'] = `token ${authToken}`
    }

    const response = await fetch(proxyInfo.proxyUrl, {
      method: 'GET',
      headers,
      timeout: 60000 // 镜像代理可能需要更长时间
    })

    if (!response.ok) {
      throw new Error(`Mirror proxy failed: ${response.status} ${response.statusText}`)
    }

    core.info('Successfully downloaded via GitHub mirror proxy')
    return Buffer.from(await response.arrayBuffer())

  } catch (error) {
    core.warning(`Mirror proxy download failed: ${error}`)
    
    // 回退到原始URL
    core.info('Falling back to direct download')
    return await downloadDirectly(originalUrl, authToken)
  }
}

/**
 * 安全地隐藏URL中的敏感信息
 */
function sanitizeProxyUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    if (urlObj.username || urlObj.password) {
      return `${urlObj.protocol}//*****:*****@${urlObj.host}${urlObj.pathname}`
    }
    return url
  } catch {
    return '[INVALID URL]'
  }
}

/**
 * 自动检测并使用最佳镜像代理下载
 */
async function downloadWithAutoMirror(
  originalUrl: string,
  authToken: string
): Promise<Buffer> {
  core.info('Auto-detecting best GitHub mirror proxy...')
  
  try {
    const detection = await detectBestMirror(undefined, 3000) // 3秒超时
    
    if (detection.bestMirror) {
      core.info(`Auto-selected mirror: ${detection.bestMirror}`)
      return await downloadWithMirrorProxy(originalUrl, authToken, detection.bestMirror)
    } else {
      core.info('No available mirrors found, using direct download')
      return await downloadDirectly(originalUrl, authToken)
    }
  } catch (error) {
    core.warning(`Mirror auto-detection failed: ${error}`)
    return await downloadDirectly(originalUrl, authToken)
  }
}

/**
 * 直接下载（无代理）
 */
async function downloadDirectly(originalUrl: string, authToken: string): Promise<Buffer> {
  const fetch = require('node-fetch')
  
  const response = await fetch(originalUrl, {
    method: 'GET',
    headers: {
      'Authorization': `token ${authToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'actions/checkout'
    },
    timeout: 30000
  })

  if (!response.ok) {
    throw new Error(`Direct download failed: ${response.status} ${response.statusText}`)
  }

  return Buffer.from(await response.arrayBuffer())
}
