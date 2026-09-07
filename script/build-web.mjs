import { cp, mkdir, rename } from "node:fs/promises"

await mkdir("public", { recursive: true })
await cp("src/web/public", "public", { recursive: true })
await rename("public/index.html", "public/app.html")
console.log("Web assets built in public/")
