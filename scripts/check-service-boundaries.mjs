import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { SourceTextModule, SyntheticModule } from 'node:vm'
import { resolve } from 'node:path'
import path from 'node:path'
import crypto from 'node:crypto'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)

const roles = { writer: 'writer', editor: 'editor', admin: 'admin' }
const entityTypes = {
    post: 'post', page: 'page', club: 'club', activity: 'activity',
    project: 'project', course: 'course', faculty: 'faculty'
}
const actor = { userId: 7, roles: Object.values(roles), source: 'mcp' }
const post = {
    id: 4, type: 'post', slug: 'article', titleDraftEN: 'Draft',
    titleDraftZH: '标题', contentDraftEN: '[]', contentDraftZH: '[]',
    createdAt: new Date(), coverImageDraftId: null
}

async function harness(currentRoles = [ 'writer' ]) {
    const events = []
    let currentUser = { id: 7, name: 'Author', roles: currentRoles }
    const receipts = new Map()
    const tokens = new Map()
    const pick = (row, select) => row && Object.fromEntries(Object.keys(select).map(key => [ key, row[key] ]))
    const prisma = {
        user: { findUnique: async () => currentUser },
        contentEntity: {
            findUnique: async () => post,
            create: async ({ data }) => {
                events.push([ 'create', data ])
                return { ...post, ...data }
            },
            update: async ({ data }) => {
                events.push([ 'update', data ])
                return { ...post, ...data }
            }
        },
        userAuditLog: { create: async ({ data }) => events.push([ 'audit', data ]) },
        approval: {
            deleteMany: async ({ where }) => events.push([ 'clearApprovals', where ]),
            groupBy: async () => []
        },
        approvalConfig: { findUnique: async () => null },
        image: { findUnique: async () => null },
        commentThread: { count: async () => 0 },
        yjsDocument: { deleteMany: async () => events.push([ 'fenceDocuments' ]) },
        $queryRaw: async (strings) => strings[0].includes('nextval') ? [ { generation: 1 } ] : [],
        mcpOperationReceipt: {
            findUnique: async ({ where }) => receipts.get(JSON.stringify(where.userId_operation_idempotencyKey)) ?? null,
            create: async ({ data }) => {
                const key = { userId: data.userId, operation: data.operation, idempotencyKey: data.idempotencyKey }
                receipts.set(JSON.stringify(key), data)
                return data
            }
        },
        personalToken: {
            create: async ({ data, select }) => {
                const row = {
                    id: `token-${tokens.size + 1}`, createdAt: new Date(), lastUsedAt: null,
                    revokedAt: null, ...data
                }
                tokens.set(row.id, row)
                return pick(row, select)
            },
            findMany: async ({
                                 where,
                                 select
                             }) => [ ...tokens.values() ].filter(row => row.userId === where.userId).map(row => pick(row, select)),
            findUnique: async ({ where }) => {
                const row = [ ...tokens.values() ].find(row => row.tokenHash === where.tokenHash)
                return row && { ...row, user: currentUser }
            },
            findFirst: async ({ where }) => {
                const row = tokens.get(where.id)
                return row?.userId === where.userId ? { id: row.id } : null
            },
            updateMany: async ({ where, data }) => {
                const row = tokens.get(where.id)
                if (!row || row.revokedAt || (where.userId != null && row.userId !== where.userId)) return { count: 0 }
                if (where.OR && row.expiresAt && row.expiresAt <= new Date()) return { count: 0 }
                Object.assign(row, data)
                return { count: 1 }
            }
        },
        $transaction: async callback => callback(prisma)
    }
    const notifications = async payload => events.push([ 'notification', payload ])
    const imagePipeline = () => {
        const pipeline = {
            rotate: () => pipeline, resize: () => pipeline,
            webp: () => pipeline, toBuffer: async () => Buffer.from('converted-image')
        }
        return pipeline
    }
    const mocks = {
        'server-only': {},
        '@/generated/prisma/client': {
            Role: roles, EntityType: entityTypes,
            CommentAnchorType: { text: 'text', component: 'component' },
            UserAuditLogType: new Proxy({}, { get: (_, key) => key })
        },
        '@/app/lib/prisma': { prisma },
        '@/app/lib/data-types': {
            getContentEntityURI: () => '/article',
            HYDRATED_CONTENT_ENTITY_SELECT: {}, SIMPLIFIED_CONTENT_ENTITY_SELECT: {},
            HydratedContentEntity: undefined, SimplifiedContentEntity: undefined, Paginated: undefined
        },
        '@/app/studio/editor/entity-types': {
            AlignEntityResponse: {
                success: 'success', notFound: 'notFound', insufficientApprovals: 'insufficientApprovals',
                unresolvedFeedback: 'unresolvedFeedback'
            }
        },
        '@puckeditor/core': { resolveAllData: async data => data },
        '@/app/lib/puck/puck-config': { PUCK_CONFIG: {} },
        '@/app/lib/metadata/website-metadata.server': { ensureWebsiteMetadataEntity: async () => post },
        '@/app/lib/metadata/website-metadata-types': {
            WEBSITE_METADATA_SLUG: '__website-metadata',
            WEBSITE_METADATA_STUDIO_PATH: '/studio/metadata',
            normalizeWebsiteMetadataContent: value => structuredClone(value),
            serializeWebsiteMetadataContent: JSON.stringify,
            parseWebsiteMetadataContent: JSON.parse,
            WEBSITE_METADATA_ENTITY_TITLE_EN: 'Website Metadata',
            WEBSITE_METADATA_ENTITY_TITLE_ZH: '网站信息'
        },
        '@/app/lib/puck/puck-comment-storage': { reconcilePuckCommentThreads: async () => events.push([ 'reconcile' ]) },
        '@/app/lib/feishu/feishu-approval': {
            sendPublicationNotification: notifications,
            sendApprovalNotification: notifications
        },
        '@/app/lib/plate/plate-types': {
            hasPlateSuggestions: () => false,
            isSerializedPlateValue: () => true, serializePlateValue: JSON.stringify
        },
        '@/app/lib/plate/plate-markdown': { deserializeMarkdownToPlate: value => value },
        '@/app/lib/puck/puck-data': { parsePuckData: JSON.parse },
        '@/app/lib/backups': {
            createContentBackup: async (_mode, filename) => {
                events.push([ 'backupCreate', filename ])
                return { backup: { filename, size: 10, createdAt: new Date().toISOString() }, created: true }
            }, listBackups: async () => {
                events.push([ 'backupRead' ])
                return []
            },
            readBackupFile: async name => {
                events.push([ 'backupDownload', name ])
                return Buffer.from('zip')
            }
        },
        '@/app/lib/collaboration/invalidate': {
            invalidateCollaborationDocuments: async () => {
            }
        },
        '@/app/lib/services/studio-actor': { getStudioActor: async () => ({ ...actor, source: 'studio' }) },
        'node:path': { default: path },
        'crypto': { default: crypto },
        'fs/promises': {
            access: async () => {
            }, mkdir: async () => {
            },
            writeFile: async filename => events.push([ 'writeFile', filename ]),
            rm: async filename => events.push([ 'removeFile', filename ])
        },
        'sharp': { default: imagePipeline },
        '@/app/studio/media/video-thumbnail': {
            ensureVideoThumbnail: async () => {
            }
        },
        'next/navigation': {
            useRouter: () => ({
                refresh() {
                }, replace() {
                }
            }), usePathname: () => '/studio/settings'
        },
        '@/app/studio/settings/personal-settings-actions': {
            createPersonalToken: async () => {
            }, revokePersonalToken: async () => {
            }
        },
        '@/app/studio/settings/feishu/feishu-actions': { getFeishuAuthUrl: async () => '' }
    }
    const cache = new Map()

    async function moduleFor(specifier, requested = []) {
        if (cache.has(specifier)) return cache.get(specifier)
        let module
        if (Object.hasOwn(mocks, specifier)) {
            const exports = mocks[specifier]
            const names = [ ...new Set([ ...Object.keys(exports), ...requested ]) ]
            module = new SyntheticModule(names, function () {
                for (const name of names) this.setExport(name, exports[name])
            }, { identifier: specifier })
        } else if (specifier.startsWith('@/')) {
            assert.ok(specifier.startsWith('@/app/lib/services/') || specifier.startsWith('@/app/lib/mcp/') ||
                specifier.startsWith('@/app/studio/settings/') ||
                specifier === '@/app/mcp/route' || specifier === '@/app/studio/editor/entity-actions', `Unexpected dependency: ${specifier}`)
            const path = resolve('src', specifier.slice(2) + '.ts')
            let source
            try {
                source = stripTypeScriptTypes(await readFile(path, 'utf8'))
            } catch (error) {
                if (error.code !== 'ENOENT') throw error
                const bindings = await require('next/dist/build/swc').loadBindings()
                source = (await bindings.transform(await readFile(path + 'x', 'utf8'), {
                    filename: path + 'x', jsc: {
                        parser: { syntax: 'typescript', tsx: true },
                        transform: { react: { runtime: 'automatic' } }
                    }, module: { type: 'es6' }
                })).code
            }
            module = new SourceTextModule(source, { identifier: specifier })
            module.serviceSource = source
        } else {
            const exports = await import(specifier)
            module = new SyntheticModule(Object.keys(exports), function () {
                for (const name of Object.keys(exports)) this.setExport(name, exports[name])
            }, { identifier: specifier })
        }
        cache.set(specifier, module)
        return module
    }

    async function load(specifier) {
        const root = await moduleFor(specifier)
        if (root.status === 'unlinked') await root.link(async (dependency, referencing) => {
            // Node's type stripping retains imports written without the type keyword.
            const names = []
            for (const match of referencing.serviceSource?.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g) ?? []) {
                if (match[2] === dependency) names.push(...match[1].split(',').map(value => value.trim().split(/\s+as\s+/)[0]))
            }
            return moduleFor(dependency, names)
        })
        if (root.status !== 'evaluated') await root.evaluate()
        return root.namespace
    }

    return {
        load, prisma, events, tokens, setUser: user => {
            currentUser = user
        }
    }
}

test('current database roles override roles supplied by the actor', async () => {
    const h = await harness([])
    const service = await h.load('@/app/lib/services/actor')
    await assert.rejects(service.requireActorUser(actor, 'admin'), /Unauthorized/)
    h.setUser({ id: 7, roles: [ 'admin' ] })
    assert.equal((await service.requireActorUser({ ...actor, roles: [] }, 'admin')).id, 7)
    h.setUser(null)
    await assert.rejects(service.requireActorUser(actor), /Unauthorized/)
})

test('invalid identities fail before database access', async () => {
    const h = await harness()
    h.prisma.user.findUnique = async () => assert.fail('Database queried for invalid identity')
    const service = await h.load('@/app/lib/services/actor')
    for (const id of [ 0, -1, 1.5, NaN ]) {
        await assert.rejects(service.requireActorUser({ ...actor, userId: id }), /Unauthorized/)
    }
})

test('entity creation attributes content and audit to the authenticated actor', async () => {
    const h = await harness()
    const service = await h.load('@/app/lib/services/entities')
    await service.createContentEntity(actor, 'page', 'New page', '新页面')
    assert.equal(h.events[0][1].creatorId, 7)
    assert.equal(JSON.parse(h.events[0][1].contentDraftEN).root.props.title, 'New page')
    assert.equal(h.events[1][1].userId, 7)
})

test('draft edits clear approvals and retain actor attribution', async () => {
    const h = await harness()
    const service = await h.load('@/app/lib/services/entities')
    await service.updateContentEntity(actor, { id: 4, titleDraftEN: 'Updated' })
    assert.equal(h.events.find(([ name ]) => name === 'audit')[1].userId, 7)
    assert.deepEqual(h.events.find(([ name ]) => name === 'clearApprovals')[1], { entityId: 4 })
})

test('metadata singleton retains its dedicated editing boundary', async () => {
    const h = await harness()
    h.prisma.contentEntity.findUnique = async () => ({ ...post, slug: '__website-metadata' })
    const service = await h.load('@/app/lib/services/entities')
    await assert.rejects(service.updateContentEntity(actor, { id: 4 }), /website settings/)
    assert.equal(h.events.length, 0)
})

test('publication uses shared approval checks and rejects insufficient approvals', async () => {
    const h = await harness([ 'admin' ])
    const service = await h.load('@/app/lib/services/entities')
    assert.equal(await service.alignContentEntity({ ...actor, source: 'studio' }, 4), 'insufficientApprovals')
    assert.equal(h.events.length, 0)
})

test('publication keeps feedback gates and notification attribution', async () => {
    const h = await harness([ 'admin' ])
    h.prisma.approval.groupBy = async () => [ { role: 'editor', _count: { role: 1 } },
        { role: 'admin', _count: { role: 1 } } ]
    h.prisma.commentThread.count = async () => 1
    const service = await h.load('@/app/lib/services/entities')
    assert.equal(await service.alignContentEntity({ ...actor, source: 'studio' }, 4), 'unresolvedFeedback')
    assert.equal(h.events.length, 0)
    h.prisma.commentThread.count = async () => 0
    const previousHost = process.env.HOST
    process.env.HOST = 'https://helium.example'
    try {
        assert.equal(await service.alignContentEntity({ ...actor, source: 'studio' }, 4), 'success')
        assert.equal(h.events.find(([ name ]) => name === 'notification')[1].publishedBy, 'Author')
        assert.equal(h.events.find(([ name ]) => name === 'audit')[1].userId, 7)
    } finally {
        if (previousHost === undefined) delete process.env.HOST
        else process.env.HOST = previousHost
    }
})

test('backup downloads enforce admin permission before reading storage', async () => {
    const h = await harness()
    const service = await h.load('@/app/lib/services/backups')
    await assert.rejects(service.downloadBackup(actor, 'backup.zip'), /Unauthorized/)
    assert.equal(h.events.length, 0)
    h.setUser({ id: 7, roles: [ 'admin' ] })
    assert.equal((await service.downloadBackup(actor, 'backup.zip')).toString(), 'zip')
})

test('comment deletion preserves its admin permission', async () => {
    const h = await harness()
    const service = await h.load('@/app/lib/services/plate-comments')
    await assert.rejects(service.deletePlateCommentThread(actor, 'thread'), /Unauthorized/)
})

test('Studio adapters forward session identity to shared entity services', async () => {
    const h = await harness()
    const actions = await h.load('@/app/studio/editor/entity-actions')
    await actions.createContentEntity('post', 'Article', '文章')
    assert.equal(h.events.find(([ name ]) => name === 'create')[1].creatorId, 7)
    assert.equal(h.events.find(([ name ]) => name === 'audit')[1].userId, 7)
})

test('duplicate uploads preserve existing media files', async () => {
    const h = await harness()
    h.prisma.image.findUnique = async () => ({ id: 9 })
    const service = await h.load('@/app/lib/services/media-upload')
    const previousPath = process.env.UPLOAD_PATH
    process.env.UPLOAD_PATH = '/virtual-uploads'
    try {
        const file = new File([ 'image' ], 'image.png', { type: 'image/png' })
        await assert.rejects(service.uploadMedia({
            ...actor,
            source: 'studio'
        }, file), error => error.code === 'duplicate')
        assert.equal((await service.uploadMedia(actor, file)).hash.length, 40)
        assert.equal(h.events.length, 0)
    } finally {
        if (previousPath === undefined) delete process.env.UPLOAD_PATH
        else process.env.UPLOAD_PATH = previousPath
    }
})

test('upload cancellation removes only files written by that operation', async () => {
    const h = await harness()
    const controller = new AbortController()
    h.prisma.image.findUnique = async () => {
        controller.abort()
        return null
    }
    const service = await h.load('@/app/lib/services/media-upload')
    const previousPath = process.env.UPLOAD_PATH
    process.env.UPLOAD_PATH = '/virtual-uploads'
    try {
        const file = new File([ 'image' ], 'image.png', { type: 'image/png' })
        await assert.rejects(service.uploadMedia(actor, file, controller.signal),
            error => error.code === 'upload-aborted')
        assert.equal(h.events.filter(([ name ]) => name === 'writeFile').length, 2)
        assert.equal(h.events.filter(([ name ]) => name === 'removeFile').length, 2)
    } finally {
        if (previousPath === undefined) delete process.env.UPLOAD_PATH
        else process.env.UPLOAD_PATH = previousPath
    }
})

test('personal token creation stores a digest and listings contain only summaries', async () => {
    const h = await harness()
    const service = await h.load('@/app/lib/services/personal-tokens')
    const created = await service.createPersonalToken({ ...actor, source: 'studio' }, {
        name: 'Codex',
        expiresAt: null
    })
    assert.match(created.token, /^hmcp_[A-Za-z0-9_-]{43}$/)
    const stored = h.tokens.get(created.summary.id)
    assert.notEqual(stored.tokenHash, created.token)
    assert.equal(stored.tokenHash, crypto.createHash('sha256').update(created.token).digest('hex'))
    const listings = await service.listPersonalTokens({ ...actor, source: 'studio' })
    assert.equal('tokenHash' in listings[0], false)
    assert.equal(JSON.stringify(listings).includes(created.token), false)
    await assert.rejects(service.createPersonalToken(actor, { name: 'MCP', expiresAt: null }), /Studio settings/)
})

test('personal tokens enforce ownership and expiration, and revocation is immediate', async () => {
    const h = await harness()
    const service = await h.load('@/app/lib/services/personal-tokens')
    const studioActor = { ...actor, source: 'studio' }
    const created = await service.createPersonalToken(studioActor, { name: 'Codex', expiresAt: null })
    assert.equal((await service.authenticatePersonalToken(created.token)).userId, 7)
    assert.ok(h.tokens.get(created.summary.id).lastUsedAt)
    assert.equal(await service.authenticatePersonalToken('invalid'), null)
    h.tokens.get(created.summary.id).expiresAt = new Date(0)
    assert.equal(await service.authenticatePersonalToken(created.token), null)
    h.tokens.get(created.summary.id).expiresAt = null
    h.setUser({ id: 8, roles: [ 'writer' ] })
    await assert.rejects(service.revokePersonalToken({
        ...studioActor,
        userId: 8
    }, { tokenId: created.summary.id }), /not found/)
    h.setUser({ id: 7, roles: [ 'writer' ] })
    await service.revokePersonalToken(studioActor, { tokenId: created.summary.id })
    assert.equal(await service.authenticatePersonalToken(created.token), null)
    await service.revokePersonalToken(studioActor, { tokenId: created.summary.id })
})

test('MCP actors cannot add or clear approvals even with every role', async () => {
    const h = await harness(Object.values(roles))
    const service = await h.load('@/app/lib/services/approvals')
    await assert.rejects(service.addApproval(actor, {
        entityType: 'post',
        entityId: 4,
        role: 'admin'
    }), /Studio approval button/)
    await assert.rejects(service.removeAllApprovals(actor, {
        entityType: 'post',
        entityId: 4
    }), /Studio approval button/)
    assert.equal(h.events.length, 0)
})

test('MCP publication checks revisions and persists successful retry receipts', async () => {
    const h = await harness([ 'admin' ])
    h.prisma.approval.groupBy = async () => [ { role: 'editor', _count: { role: 1 } },
        { role: 'admin', _count: { role: 1 } } ]
    const service = await h.load('@/app/lib/services/publication')
    const revisionModule = await h.load('@/app/lib/mcp/entity-revision')
    assert.equal((await service.publishDraft(actor, 4, {
        expectedRevision: 'stale',
        idempotencyKey: 'stale'
    })).status, 'conflict')
    assert.equal(h.events.length, 0)
    const command = { expectedRevision: revisionModule.entityRevision(post), idempotencyKey: 'publish-once' }
    assert.equal((await service.publishDraft(actor, 4, command)).status, 'success')
    assert.equal((await service.publishDraft(actor, 4, command)).replayed, true)
    assert.equal(h.events.filter(([ name ]) => name === 'update').length, 1)
    assert.equal(h.events.filter(([ name ]) => name === 'audit').length, 1)
    assert.equal(h.events.filter(([ name ]) => name === 'notification').length, 1)
    assert.equal((await service.publishDraft(actor, 4, {
        ...command,
        expectedRevision: 'changed'
    })).status, 'idempotency_key_reused')
})

test('real MCP transport advertises discovery and publication with approval actions excluded', async () => {
    const h = await harness([ 'admin' ])
    const tokens = await h.load('@/app/lib/services/personal-tokens')
    const created = await tokens.createPersonalToken({ ...actor, source: 'studio' }, { name: 'Codex', expiresAt: null })
    const route = await h.load('@/app/mcp/route')
    const previousHost = process.env.HOST
    process.env.HOST = 'https://helium.example'
    const request = (method, parameters = {}, token = created.token, origin) => new Request('https://helium.example/mcp', {
        method: 'POST', headers: {
            'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18', ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(origin ? { Origin: origin } : {})
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: parameters })
    })
    try {
        assert.equal((await route.POST(request('tools/list', {}, ''))).status, 401)
        assert.equal((await route.POST(request('tools/list', {}, created.token, 'https://other.example'))).status, 403)
        const response = await route.POST(request('tools/list'))
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('cache-control'), 'no-store')
        const body = await response.text()
        const payload = response.headers.get('content-type').includes('text/event-stream')
            ? JSON.parse(body.split('\n').find(line => line.startsWith('data: ')).slice(6)) : JSON.parse(body)
        const names = payload.result.tools.map(tool => tool.name)
        assert.ok(names.includes('get_entity'))
        assert.ok(names.includes('publish_entity'))
        assert.ok(names.includes('get_editor_document'))
        assert.ok(names.includes('edit_editor_document'))
        for (const name of [ 'update_entity_fields', 'replace_editor_document', 'create_entity', 'delete_entity', 'unpublish_entity', 'restore_entity', 'search_images', 'view_image', 'upload_image', 'delete_image', 'get_website_metadata', 'update_website_metadata', 'list_backups', 'create_backup' ]) assert.ok(names.includes(name), name)
        assert.equal(names.some(name => /approve|add_approval|remove.*approval/.test(name)), false)
        const call = await route.POST(request('tools/call', { name: 'get_account', arguments: {} }))
        assert.equal(call.status, 200)
        const text = await call.text()
        assert.ok(text.includes('Author'))
        assert.equal(text.includes(created.token), false)
        await tokens.revokePersonalToken({ ...actor, source: 'studio' }, { tokenId: created.summary.id })
        assert.equal((await route.POST(request('tools/list'))).status, 401)
    } finally {
        if (previousHost === undefined) delete process.env.HOST
        else process.env.HOST = previousHost
    }
})

test('personal settings renders Feishu and token sections with summary data', async () => {
    const h = await harness()
    const component = await h.load('@/app/studio/settings/PersonalSettings')
    const html = renderToStaticMarkup(createElement(component.default, {
        isFeishuLinked: true, result: {}, endpoint: 'https://helium.example/mcp',
        tokens: [ {
            id: 'example-token', name: 'My Codex', prefix: 'hmcp_example',
            createdAt: new Date().toISOString(), expiresAt: null, lastUsedAt: null, revokedAt: null
        } ]
    }))
    for (const label of [ '个人设置', '飞书设置', 'MCP 个人令牌', 'My Codex', '生成令牌', '撤销 My Codex' ]) {
        assert.ok(html.includes(label), `Missing settings content: ${label}`)
    }
    assert.ok(html.includes('HELIUM_MCP_TOKEN'))
    assert.ok(html.includes('https://helium.example/mcp'))
})


test('MCP field patches check every expected value before writing and replay successful receipts', async () => {
    const h = await harness()
    const service = await h.load('@/app/lib/services/mcp-mutations')
    const input = {
        entityId: post.id,
        idempotencyKey: 'fields',
        changes: [ { field: 'titleDraftEN', expected: post.titleDraftEN, value: 'Updated' } ]
    }
    const first = await service.patchEntityFields(actor, input)
    assert.equal(first.ok, true)
    assert.equal((await service.patchEntityFields(actor, input)).replayed, true)
    assert.equal(h.events.filter(([ kind ]) => kind === 'update').length, 1)
    const changed = await service.patchEntityFields(actor, {
        ...input,
        changes: [ { ...input.changes[0], value: 'Different' } ]
    })
    assert.equal(changed.error.code, 'idempotency_key_reused')
    const conflict = await service.patchEntityFields(actor, {
        ...input,
        idempotencyKey: 'conflict',
        changes: [ { ...input.changes[0], expected: 'Earlier' } ]
    })
    assert.equal(conflict.error.code, 'conflict')
    assert.equal(h.events.filter(([ kind ]) => kind === 'update').length, 1)
})

test('MCP creation is receipted and deletion enforces editor permission', async () => {
    const h = await harness()
    const service = await h.load('@/app/lib/services/mcp-mutations')
    const input = { idempotencyKey: 'create', type: 'post', titleEN: 'New article', titleZH: '文章' }
    assert.equal((await service.createMcpEntity(actor, input)).ok, true)
    assert.equal((await service.createMcpEntity(actor, input)).replayed, true)
    assert.equal(h.events.filter(([ kind ]) => kind === 'create').length, 1)
    await assert.rejects(service.mutateEntityLifecycle(actor, 'delete_entity', {
        entityId: 4,
        expectedRevision: 'revision',
        idempotencyKey: 'delete'
    }), /Unauthorized/)
})

test('MCP restoration advances the document generation with both languages in one transaction', async () => {
    const h = await harness()
    const service = await h.load('@/app/lib/services/mcp-mutations')
    const revision = await h.load('@/app/lib/mcp/entity-revision')
    const published = {
        ...post,
        titlePublishedEN: post.titleDraftEN,
        titlePublishedZH: post.titleDraftZH,
        contentPublishedEN: post.contentDraftEN,
        contentPublishedZH: post.contentDraftZH
    }
    h.prisma.contentEntity.findUnique = async () => published
    const result = await service.mutateEntityLifecycle(actor, 'restore_entity', {
        entityId: post.id,
        expectedRevision: revision.entityRevision(published),
        idempotencyKey: 'restore'
    })
    assert.equal(result.ok, true)
    const update = h.events.find(([ kind ]) => kind === 'update')[1]
    assert.equal(update.collaborationGeneration, 1)
    assert.equal(update.contentDraftEN, post.contentDraftEN)
    assert.ok(h.events.some(([ kind ]) => kind === 'fenceDocuments'))
    assert.ok(h.events.some(([ kind ]) => kind === 'clearApprovals'))
})


test('website metadata uses singleton revision checks and retains personal approval gates', async () => {
    const h = await harness()
    const entity = { ...post, slug: '__website-metadata' }
    h.prisma.contentEntity.findUnique = async () => entity
    const service = await h.load('@/app/lib/services/mcp-settings-backups')
    const revision = await h.load('@/app/lib/mcp/entity-revision')
    const content = {
        title: 'Site',
        description: '',
        navbar: [],
        footer: {
            items: [],
            phoneText: '',
            emailText: '',
            copyrightText: '',
            chineseWebsiteUrl: '',
            chineseWebsiteText: '',
            icpNumber: ''
        }
    }
    const input = {
        entityId: post.id,
        idempotencyKey: 'metadata',
        expectedRevision: revision.entityRevision(entity),
        draft: { en: content, zh: content }
    }
    assert.equal((await service.saveMcpMetadata(actor, { ...input, expectedRevision: 'stale' })).error.code, 'conflict')
    assert.equal(h.events.length, 0)
    assert.equal((await service.saveMcpMetadata(actor, input)).ok, true)
    assert.equal((await service.saveMcpMetadata(actor, input)).replayed, true)
    assert.ok(h.events.some(([ kind ]) => kind === 'clearApprovals'))
    assert.equal(h.events.filter(([ kind ]) => kind === 'update').length, 1)
})

test('backup creation requires admin and reuses its archive and successful receipt', async () => {
    const writer = await harness()
    const denied = await writer.load('@/app/lib/services/mcp-settings-backups')
    await assert.rejects(denied.createMcpBackup(actor, { idempotencyKey: 'backup' }), /Unauthorized/)
    assert.equal(writer.events.length, 0)
    const h = await harness([ 'admin' ])
    const service = await h.load('@/app/lib/services/mcp-settings-backups')
    const first = await service.createMcpBackup(actor, { idempotencyKey: 'backup' })
    assert.equal(first.ok, true)
    assert.ok(first.data.downloadPath.startsWith('/mcp/transfers/backups/'))
    assert.equal((await service.createMcpBackup(actor, { idempotencyKey: 'backup' })).replayed, true)
    assert.equal(h.events.filter(([ kind ]) => kind === 'backupCreate').length, 1)
})

test('image deletion reports saved draft and published references before applying Studio policy', async () => {
    const h = await harness()
    const image = { id: 9, sha1: 'a'.repeat(40), extension: 'webp', mediaType: 'image' }
    h.prisma.image.findUnique = async () => image
    h.prisma.image.delete = async () => h.events.push([ 'imageDelete' ])
    h.prisma.contentEntity.findMany = async () => [ {
        ...post,
        coverImageDraftId: null,
        contentPublishedZH: '{"imageId":9}'
    } ]
    const service = await h.load('@/app/lib/services/mcp-media')
    const input = { imageId: 9, expectedHash: image.sha1, idempotencyKey: 'image-delete' }
    const referenced = await service.deleteMcpImage(actor, input)
    assert.equal(referenced.error.code, 'conflict')
    assert.equal(referenced.error.references[0].entityId, post.id)
    assert.equal(h.events.length, 0)
    assert.equal((await service.deleteMcpImage(actor, { ...input, allowReferenced: true })).ok, true)
    assert.equal(h.events.filter(([ kind ]) => kind === 'imageDelete').length, 1)
})

test('Studio scalar expectations prevent overwriting newer MCP edits', async () => {
    const h = await harness()
    const service = await h.load('@/app/lib/services/entities')
    await assert.rejects(service.updateContentEntity({ ...actor, source: 'studio' }, {
        id: post.id,
        titleDraftEN: 'Updated', expectedFields: { titleDraftEN: 'Earlier' }
    }), /fields have changed/)
    assert.equal(h.events.length, 0)
})
