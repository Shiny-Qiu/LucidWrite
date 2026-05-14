import { handle } from "hono/vercel"
import app from "../src/web/server"

export const config = { runtime: "nodejs" }

export default handle(app)
