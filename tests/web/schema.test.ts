import { afterAll, beforeAll, expect, test } from "bun:test"
import { PGlite } from "@electric-sql/pglite"
import { readFileSync } from "node:fs"

const db = new PGlite()
const userA = "11111111-1111-4111-8111-111111111111"
const userB = "22222222-2222-4222-8222-222222222222"
const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const migration = readFileSync(new URL("../../supabase/migrations/202609070001_web_functionality.sql", import.meta.url), "utf8")
beforeAll(async () => {
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    create function public.uuid_generate_v4() returns uuid language sql as $$ select gen_random_uuid() $$;
  `)
  // PGlite has gen_random_uuid built in; the production extension provides the same UUID default.
  const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8")
    .replace('create extension if not exists "uuid-ossp";', "")
  await db.exec(schema)
  await db.query("insert into auth.users values ($1, 'one@example.test'), ($2, 'two@example.test')", [userA, userB])
  await db.query("insert into projects(id,user_id,name) values ($1,$2,'项目甲'),($3,$4,'项目乙')", [projectA, userA, projectB, userB])
  await db.query("insert into drafts(project_id,user_id,content) values ($1,$2,'existing draft')", [projectA, userA])
  await db.exec(migration)
  await db.exec("grant select,insert,update,delete on projects,drafts,finals,style_fingerprints to authenticated")
}, 30_000)
afterAll(async () => { await db.close() })

async function asUser(id: string, sql: string, params: any[] = []) {
  await db.exec("set role authenticated")
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id])
    return await db.query(sql, params)
  } finally { await db.exec("reset role") }
}

test("migration is repeatable and preserves existing articles", async () => {
  await db.exec(migration)
  const { rows } = await db.query<any>("select content from drafts where project_id=$1", [projectA])
  expect(rows[0].content).toBe("existing draft")
})
test("users can store and read their own settings but not another user's keys", async () => {
  await asUser(userA, "insert into user_settings(user_id,providers) values ($1,$2)", [userA, { deepseek: "private-test-key" }])
  expect((await asUser(userA, "select * from user_settings")).rows.length).toBe(1)
  expect((await asUser(userB, "select * from user_settings")).rows.length).toBe(0)
  await expect(asUser(userB, "insert into user_settings(user_id) values ($1)", [userA])).rejects.toThrow()
})
test("RLS blocks attaching a user-owned draft to someone else's project", async () => {
  await expect(asUser(userA, "insert into finals(project_id,user_id,content) values ($1,$2,'bad')", [projectB, userA])).rejects.toThrow()
  expect((await asUser(userB, "select * from drafts")).rows).toHaveLength(0)
  await asUser(userA, "insert into finals(project_id,user_id,content) values ($1,$2,'own final')", [projectA, userA])
})
test("task records and workflow progress remain scoped to their project owner", async () => {
  await asUser(userA, "insert into writing_tasks(user_id,project_id,project_name,mode,status) values ($1,$2,'项目甲','write','running')", [userA, projectA])
  expect((await asUser(userA, "select * from writing_tasks")).rows).toHaveLength(1)
  expect((await asUser(userB, "select * from writing_tasks")).rows).toHaveLength(0)
  await expect(asUser(userA, "insert into writing_tasks(user_id,project_id,project_name,mode,status) values ($1,$2,'项目乙','write','running')", [userA, projectB])).rejects.toThrow()
  await asUser(userA, "update projects set state=$1 where id=$2", [{ currentStep: "draft" }, projectA])
  expect((await asUser(userB, "select state from projects where id=$1", [projectA])).rows).toHaveLength(0)
})

test("only the owner can delete a project, with draft, final and task rows cascading atomically", async () => {
  const project = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  await asUser(userA, "insert into projects(id,user_id,name,state) values ($1,$2,'删除验收',$3)", [project, userA, { chat: [{ content: "对话" }] }])
  for (const table of ["drafts", "finals"]) await asUser(userA, `insert into ${table}(project_id,user_id,content) values ($1,$2,'正文')`, [project, userA])
  await asUser(userA, "insert into writing_tasks(project_id,user_id,project_name,mode,status) values ($1,$2,'删除验收','write','completed')", [project, userA])
  expect((await asUser(userB, "delete from projects where id=$1 returning id", [project])).rows).toHaveLength(0)
  expect((await asUser(userA, "select * from drafts where project_id=$1", [project])).rows).toHaveLength(1)
  expect((await asUser(userA, "delete from projects where id=$1 returning id", [project])).rows).toEqual([{ id: project }])
  for (const table of ["drafts", "finals", "writing_tasks"]) expect((await db.query(`select * from ${table} where project_id=$1`, [project])).rows).toHaveLength(0)
  expect((await db.query("select id from projects where id in ($1,$2)", [projectA, projectB])).rows).toHaveLength(2)
})
