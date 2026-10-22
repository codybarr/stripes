import page from "./index.html"

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8792),
  routes: {
    "/": page,
    "/favicon.ico": () => new Response(null, { status: 204 }),
  },
  development: true,
})
console.log(`Printer bench: ${server.url}`)
