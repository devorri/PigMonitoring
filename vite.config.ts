import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import smsHandler from './netlify/functions/sms.mts'

// npm run dev: serve /api/sms locally with the same code Netlify runs online
function smsApiDev(): Plugin {
  return {
    name: 'sms-api-dev',
    configureServer(server) {
      server.middlewares.use('/api/sms', async (req, res) => {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const request = new Request('http://localhost/api/sms', {
          method: req.method,
          headers: { 'Content-Type': 'application/json' },
          body: req.method === 'POST' ? Buffer.concat(chunks).toString('utf8') : undefined,
        })
        const response = await smsHandler(request)
        res.statusCode = response.status
        res.setHeader('Content-Type', 'application/json')
        res.end(await response.text())
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // make .env values (incl. SEMAPHORE_API_KEY, no VITE_ prefix) visible to the dev SMS endpoint
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''))

  return {
    plugins: [react(), smsApiDev()],
    server: {
      proxy: {
        '/camera-stream': {
          target: 'http://192.168.100.119',
          changeOrigin: false,
          rewrite: () => '/',
        },
      },
    },
  }
})
