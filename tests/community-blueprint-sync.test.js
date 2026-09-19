const assert = require('assert')

const {
  isBloxelizerApiUrl,
  resolveDownloadUrlFromPage
} = require('../scripts/sync-community-blueprints')

async function withFetchStub(stub, fn) {
  const original = global.fetch
  global.fetch = stub
  try {
    return await fn()
  } finally {
    global.fetch = original
  }
}

async function testResolvesPublicBloxelizerApiMetadataToCdnDownload() {
  const apiUrl = 'https://api.bloxelizer.com/api/schematics/87fef35c-0aee-46b1-ac06-780db8cd3813'
  const requests = []
  const result = await withFetchStub(async (url, options) => {
    requests.push({ url, options })
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return {
          id: '87fef35c-0aee-46b1-ac06-780db8cd3813',
          render_token: 'public token/+',
          visibility: 'public',
          upload_status: 'completed',
          locked: false
        }
      }
    }
  }, () => resolveDownloadUrlFromPage(apiUrl, {
    sourcePageIdentifier: 'https://bloxelizer.com/schematics/survival-castle'
  }))

  assert.strictEqual(result.ok, true, result.error)
  assert.strictEqual(requests.length, 1)
  assert.strictEqual(requests[0].url, apiUrl)
  assert.strictEqual(requests[0].options.headers.Accept, 'application/json')
  assert.strictEqual(result.page, apiUrl)
  assert.strictEqual(result.referer, 'https://bloxelizer.com/schematics/survival-castle')
  assert.strictEqual(
    result.url,
    'https://bloxelizer.com/cdn/schematics/87fef35c-0aee-46b1-ac06-780db8cd3813?t=public%20token%2F%2B'
  )
}

async function testRejectsPrivateOrIncompleteBloxelizerMetadata() {
  const result = await withFetchStub(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      return {
        id: 'private-id',
        render_token: 'token',
        visibility: 'private',
        upload_status: 'completed',
        locked: false
      }
    }
  }), () => resolveDownloadUrlFromPage(
    'https://api.bloxelizer.com/api/schematics/private-id'
  ))

  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'bloxelizer_schematic_not_public_and_ready')
}

function testOnlyAcceptsExactHttpsBloxelizerSchematicApiUrls() {
  assert.strictEqual(isBloxelizerApiUrl('https://api.bloxelizer.com/api/schematics/abc'), true)
  assert.strictEqual(isBloxelizerApiUrl('http://api.bloxelizer.com/api/schematics/abc'), false)
  assert.strictEqual(isBloxelizerApiUrl('https://api.bloxelizer.com/api/users/abc'), false)
  assert.strictEqual(isBloxelizerApiUrl('https://example.com/api/schematics/abc'), false)
}

async function run() {
  testOnlyAcceptsExactHttpsBloxelizerSchematicApiUrls()
  await testResolvesPublicBloxelizerApiMetadataToCdnDownload()
  await testRejectsPrivateOrIncompleteBloxelizerMetadata()
  console.log('community-blueprint-sync tests passed')
}

run().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
