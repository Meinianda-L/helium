'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { PersonalTokenSummary } from '@/app/lib/mcp/contracts'
import FeishuSettings from '@/app/studio/settings/feishu/FeishuSettings'
import { createPersonalToken, revokePersonalToken } from '@/app/studio/settings/personal-settings-actions'

export default function PersonalSettings({ isFeishuLinked, tokens, result, endpoint }: {
    isFeishuLinked: boolean
    tokens: PersonalTokenSummary[]
    result: { success?: string; error?: string }
    endpoint: string
}) {
    const router = useRouter()
    const [ name, setName ] = useState('')
    const [ expiration, setExpiration ] = useState('90')
    const [ secret, setSecret ] = useState<string | null>(null)
    const [ feedback, setFeedback ] = useState('')
    const [ error, setError ] = useState('')
    const [ pending, startTransition ] = useTransition()
    const buttonClass = 'rounded-full bg-blue-600 px-5 py-2.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50'
    const configuration = `[mcp_servers.helium]\nurl = "${endpoint}"\nbearer_token_env_var = "HELIUM_MCP_TOKEN"`

    function generate() {
        setError('')
        setFeedback('')
        startTransition(async () => {
            try {
                const expiresAt = expiration === 'never' ? null
                    : new Date(Date.now() + Number(expiration) * 86400000).toISOString()
                const created = await createPersonalToken({ name, expiresAt })
                setSecret(created.token)
                setName('')
                router.refresh()
            } catch {
                setError('令牌生成失败，请重试。')
            }
        })
    }

    function revoke(tokenId: string) {
        setError('')
        setFeedback('')
        startTransition(async () => {
            try {
                await revokePersonalToken({ tokenId })
                setSecret(null)
                setFeedback('令牌已撤销。')
                router.refresh()
            } catch {
                setError('令牌撤销失败，请重试。')
            }
        })
    }

    async function copySecret() {
        if (!secret) return
        try {
            await navigator.clipboard.writeText(secret)
            setFeedback('令牌已复制。')
        } catch {
            setError('复制失败，请选择令牌后手动复制。')
        }
    }

    return <div className="p-8 lg:p-16 space-y-10 max-w-6xl">
        <h1 className="text-2xl">个人设置</h1>
        <FeishuSettings isLinked={isFeishuLinked} result={result} embedded/>
        <section aria-labelledby="mcp-tokens-title" className="space-y-6">
            <h2 id="mcp-tokens-title" className="text-xl">MCP 个人令牌</h2>
            <div className="rounded-3xl bg-gray-50 p-8 space-y-6">
                <p className="secondary">通过个人令牌连接 Codex，使用当前账号的 Helium 权限。内容审核需要在 Studio
                    审核页面点击审批按钮。</p>
                <form onSubmit={event => {
                    event.preventDefault()
                    generate()
                }} className="flex flex-wrap items-end gap-4">
                    <label className="flex flex-col gap-2 flex-1 min-w-48">
                        <span className="text-sm">令牌名称</span>
                        <input value={name} onChange={event => setName(event.target.value)} required
                               maxLength={100} placeholder="例如：我的 Codex"
                               className="rounded-xl border border-gray-300 bg-white p-3"/>
                    </label>
                    <label className="flex flex-col gap-2">
                        <span className="text-sm">有效期</span>
                        <select value={expiration} onChange={event => setExpiration(event.target.value)}
                                className="rounded-xl border border-gray-300 bg-white p-3">
                            <option value="30">30 天</option>
                            <option value="90">90 天</option>
                            <option value="365">365 天</option>
                            <option value="never">长期有效</option>
                        </select>
                    </label>
                    <button type="submit" disabled={pending || !name.trim()} className={buttonClass}>生成令牌</button>
                </form>
                {secret && <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5 space-y-3">
                    <p className="text-sm">完整令牌仅在本次生成后显示，请复制并保存在安全的位置。</p>
                    <code className="block break-all rounded-lg bg-white p-3 select-all">{secret}</code>
                    <div className="flex gap-3">
                        <button type="button" onClick={copySecret} className={buttonClass}>复制令牌</button>
                        <button type="button" onClick={() => setSecret(null)} className="text-sm underline">隐藏令牌
                        </button>
                    </div>
                </div>}
                {error && <p role="alert" className="text-red-600">{error}</p>}
                {feedback && <p role="status" className="text-green-700">{feedback}</p>}
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <caption className="sr-only">当前账号的 MCP 个人令牌</caption>
                        <thead>
                        <tr className="border-b border-gray-200">
                            <th className="py-3 pr-4">名称</th>
                            <th className="pr-4">状态</th>
                            <th className="pr-4">到期时间</th>
                            <th className="pr-4">最近使用</th>
                            <th>操作</th>
                        </tr>
                        </thead>
                        <tbody>{tokens.map(token => {
                            const expired = token.expiresAt != null && new Date(token.expiresAt) <= new Date()
                            return <tr key={token.id} className="border-b border-gray-200">
                                <td className="py-4 pr-4"><p>{token.name}</p><code
                                    className="text-xs secondary">{token.prefix}…</code></td>
                                <td className="pr-4">{token.revokedAt ? '已撤销' : expired ? '已过期' : '有效'}</td>
                                <td className="pr-4">{token.expiresAt ? new Date(token.expiresAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '长期有效'}</td>
                                <td className="pr-4">{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚未使用'}</td>
                                <td>{!token.revokedAt && <button type="button" onClick={() => revoke(token.id)}
                                                                 disabled={pending}
                                                                 className="text-red-600 underline disabled:opacity-50"
                                                                 aria-label={`撤销 ${token.name}`}>撤销</button>}</td>
                            </tr>
                        })}</tbody>
                    </table>
                    {tokens.length === 0 && <p className="py-4 secondary">生成个人令牌后，即可连接 Codex。</p>}
                </div>
                <details className="space-y-3">
                    <summary className="cursor-pointer text-sm">Codex 连接设置</summary>
                    <p className="text-sm secondary">MCP 地址：<code className="break-all">{endpoint}</code></p>
                    <p className="text-sm secondary">在 Codex 配置中添加以下内容，并将个人令牌保存到 HELIUM_MCP_TOKEN
                        环境变量。</p>
                    <pre className="overflow-x-auto rounded-xl bg-white p-4 text-sm">{configuration}</pre>
                </details>
            </div>
        </section>
    </div>
}
