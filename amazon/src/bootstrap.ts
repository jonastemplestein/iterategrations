import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Export only Amazon cookies from a new task tab in an existing real Chrome session. */
export function bootstrap(input: {
  session: string;
  output: string;
  credentialsFile?: string;
}): void {
  if (!/^[0-9]+$/.test(input.session)) throw new Error("amazon: invalid Playwriter session ID");
  if (input.credentialsFile && statSync(input.credentialsFile).mode & 0o077)
    throw new Error("amazon: credentials file must have mode 600");
  const folder = mkdtempSync(join(tmpdir(), "amazon-bootstrap-"));
  chmodSync(folder, 0o700);
  const output = join(folder, "session.json");
  const script = join(folder, "bootstrap.js");
  // Credentials remain in a private file. They never enter a shell argument or tool output.
  writeFileSync(
    script,
    `
state.amazonBootstrapPage ??= await context.newPage();
state.page = state.amazonBootstrapPage;
await state.page.goto("https://www.amazon.co.uk/",{waitUntil:"domcontentloaded"});
await waitForPageLoad({page:state.page,timeout:5000});
await snapshot({page:state.page}); await getLatestLogs({page:state.page,sinceLastCall:true});
const account=state.page.locator("#nav-link-yourAccount,#nav-link-accountList").first();
if(!/sign in/i.test(await account.innerText()) && ${JSON.stringify(!!input.credentialsFile)}) throw new Error("amazon: credentials supplied but Chrome already has an Amazon login; do not silently use a different account");
if(/sign in/i.test(await account.innerText()) && ${JSON.stringify(!!input.credentialsFile)}) {
  const credentials=JSON.parse(require("node:fs").readFileSync(${JSON.stringify(input.credentialsFile ?? "")},"utf8"));
  await account.click(); await snapshot({page:state.page}); await getLatestLogs({page:state.page,sinceLastCall:true});
  const email=state.page.locator("input[type=email],#ap_email_login,#ap_email").first();
  await email.click(); await email.fill(credentials.email);
  await snapshot({page:state.page}); await getLatestLogs({page:state.page,sinceLastCall:true});
  await state.page.locator("#continue").click();
  await snapshot({page:state.page}); await getLatestLogs({page:state.page,sinceLastCall:true});
  if(await state.page.locator("#captchacharacters,#auth-mfa-otpcode").count()) throw new Error("amazon: human_login_required");
  const password=state.page.locator("input[type=password]").first();
  await password.click(); await password.fill(credentials.password);
  await snapshot({page:state.page}); await getLatestLogs({page:state.page,sinceLastCall:true});
  await state.page.locator("#signInSubmit").click();
  await waitForPageLoad({page:state.page,timeout:5000});
  await snapshot({page:state.page}); await getLatestLogs({page:state.page,sinceLastCall:true});
}
if(await state.page.locator("#captchacharacters,#auth-mfa-otpcode,input[type=password]").count()) throw new Error("amazon: human_login_required");
const cdp=await getCDPSession({page:state.page});
const cookies=(await cdp.send("Network.getCookies",{urls:["https://www.amazon.co.uk/"]})).cookies;
if(!cookies.some(c=>["at-acbuk","sess-at-acbuk"].includes(c.name))) throw new Error("amazon: human_login_required");
const userAgent=await state.page.evaluate(()=>navigator.userAgent);
require("node:fs").writeFileSync(${JSON.stringify(output)},JSON.stringify({cookies,userAgent}),{mode:384});
console.log("Amazon session exported. No order submitted.");
`,
    { mode: 0o600 },
  );
  try {
    execFileSync("playwriter", ["-s", input.session, "--timeout", "45000", "-f", script], {
      stdio: "pipe",
      timeout: 55000,
    });
    const data = readFileSync(output);
    mkdirSync(dirname(input.output), { recursive: true, mode: 0o700 });
    writeFileSync(input.output, data, { mode: 0o600 });
    chmodSync(input.output, 0o600);
  } catch {
    throw new Error(
      "amazon: bootstrap did not complete; inspect the new Amazon tab and finish any login challenge, then run bootstrap again",
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.env.AMAZON_PLAYWRITER_SESSION && process.env.AMAZON_SESSION_FILE) {
  try {
    bootstrap({
      session: process.env.AMAZON_PLAYWRITER_SESSION,
      output: process.env.AMAZON_SESSION_FILE,
      credentialsFile: process.env.AMAZON_CREDENTIALS_FILE,
    });
    console.log("Private Amazon session saved.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "amazon: bootstrap failed");
    process.exitCode = 1;
  }
}
