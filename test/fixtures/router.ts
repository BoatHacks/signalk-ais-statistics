// A minimal stand-in for the plugin router: records handlers by path and
// which access level they were registered with.
import type { RequestHandler } from 'express'

export interface Recorded {
  handler: RequestHandler
  access: 'readonly' | 'admin'
}

export function fakeRouter(withAccess = true) {
  const routes = new Map<string, Recorded>()
  const getter = (access: Recorded['access']) => ({
    get(path: string, handler: RequestHandler) {
      routes.set(path, { handler, access })
    },
  })
  const router = {
    ...getter('admin'),
    ...(withAccess ? { access: () => getter('readonly') } : {}),
  }
  async function call(path: string, query: Record<string, string> = {}) {
    const route = routes.get(path)
    if (!route) throw new Error(`no route ${path}`)
    return new Promise<{ status: number; body: unknown }>((resolve) => {
      let status = 200
      const res = {
        setHeader() {},
        status(s: number) {
          status = s
          return res
        },
        json(body: unknown) {
          resolve({ status, body })
        },
      }
      void route.handler(
        { query } as never,
        res as never,
        (() => undefined) as never,
      )
    })
  }
  return { router, routes, call }
}
