// Creates a dashboard user and prints a one-time random password.
// Usage: npm run user:create -- --email you@studio.com --name "Your Name" --role admin|manager|designer
import { loadEnvFile } from "node:process";
import fs from "node:fs";
import { parseArgs } from "node:util";

if (fs.existsSync(".env.local")) loadEnvFile(".env.local");
else if (fs.existsSync(".env")) loadEnvFile(".env");

const { values } = parseArgs({
  options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string", default: "manager" } },
});
const role = values.role as "admin" | "manager" | "designer";
if (!values.email || !values.name || !["admin", "manager", "designer"].includes(role)) {
  console.error('Usage: npm run user:create -- --email you@studio.com --name "Your Name" --role admin|manager|designer');
  process.exit(1);
}

const { getDb } = await import("../src/server/db/client.ts");
const { createUser, findUserByEmail } = await import("../src/server/repo/users.ts");
const { generatePassword } = await import("../src/server/auth/password.ts");
const db = await getDb();
if (await findUserByEmail(db, values.email)) {
  console.error("A user with that email already exists.");
  process.exit(1);
}
const password = generatePassword();
await createUser(db, { email: values.email, name: values.name, role, password });
console.log(`Created ${role} ${values.email} in the ${db.kind} database.`);
console.log(`One-time password (store it in a password manager now; it is not saved anywhere): ${password}`);
process.exit(0);
