// A minimal stand-in for the plugin router: records handlers by method and
// path and which access level they were registered with.
import type { RequestHandler } from 'express'

export type Access = 'readonly' | 'readwrite' | 'admin'

export interface Recorded {
  handler: RequestHandler
  access: Access
}

export interface CallOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  headers?: Record<string, string>
}

export function fakeRouter(withAccess = true) {
  /** Keyed by path for GET and by "POST path" for POST. */
  const routes = new Map<string, Recorded>()
  const scoped = (access: Access) => ({
    get(path: string, handler: RequestHandler) {
      routes.set(path, { handler, access })
    },
    post(path: string, handler: RequestHandler) {
      routes.set(`POST ${path}`, { handler, access })
    },
  })
  const router = {
    ...scoped('admin'),
    ...(withAccess
      ? { access: (level: 'readonly' | 'readwrite') => scoped(level) }
      : {}),
  }
  async function call(
    path: string,
    query: Record<string, string> = {},
    { method = 'GET', body, headers = {} }: CallOptions = {},
  ) {
    const key = method === 'GET' ? path : `${method} ${path}`
    const route = routes.get(key)
    if (!route) throw new Error(`no route ${key}`)
    return new Promise<{
      status: number
      body: unknown
      headers: Record<string, string>
    }>((resolve) => {
      let status = 200
      const sent: Record<string, string> = {}
      const res = {
        setHeader(name: string, value: string) {
          sent[name.toLowerCase()] = value
        },
        status(s: number) {
          status = s
          return res
        },
        json(b: unknown) {
          resolve({ status, body: b, headers: sent })
        },
        send(b: unknown) {
          resolve({ status, body: b, headers: sent })
        },
      }
      void route.handler(
        { query, body, headers, method } as never,
        res as never,
        (() => undefined) as never,
      )
    })
  }
  /** POSTs JSON, as the web app does. */
  const post = (
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ) =>
    call(
      path,
      {},
      {
        method: 'POST',
        body,
        headers: headers ?? { 'content-type': 'application/json' },
      },
    )
  return { router, routes, call, post }
}
