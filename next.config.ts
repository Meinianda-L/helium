import type { NextConfig } from 'next'
import withFlowbiteReact from 'flowbite-react/plugin/nextjs'

const nextConfig: NextConfig = {
    poweredByHeader: false,
    async headers() {
        return [
            {
                source: '/:path*',
                headers: [
                    { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
                    { key: 'X-Content-Type-Options', value: 'nosniff' },
                    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
                    { key: 'Content-Security-Policy', value: 'frame-ancestors \'self\'; base-uri \'self\'; object-src \'none\'' }
                ]
            }
        ]
    },
    experimental: {
        proxyClientMaxBodySize: '250mb',
        serverActions: {
            allowedOrigins: [
                'isba.beijingacademy.com.cn',
                'baid.beijingacademy.com.cn',
                '10.85.160.111',
                '10.85.160.111:8523'
            ]
        }
    }
}

export default withFlowbiteReact(nextConfig)
