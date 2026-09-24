// The sign-up form, from the point of view of somebody meeting it for the
// first time.
//
// The report that prompted this: refused five times, "wrong password", then not
// let in until the email was confirmed, and nearly gone within thirty seconds.
//
// Three things here, and each of them failed before the fix:
//
//   1. The password field demanded a lowercase letter, an uppercase letter, a
//      digit, a symbol and eight characters at once, and said only
//      "Still needed: ..." until every one was met. NIST SP 800-63B asks for
//      the opposite: a length floor and no composition rules.
//   2. The first field is focused when the form opens. Moving to the next one
//      marked it touched, and an empty required field is invalid, so it turned
//      red before anything had been typed.
//   3. An account whose confirmation email never arrived had nowhere to go.
//      Signing in says "not confirmed" and there was nothing to press.
import { launch, BASE } from '../lib/browser.mjs';

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const ctx = await b.newContext({ viewport: { width: 480, height: 900 } });

/** The sign-up form, opened and ready. */
async function signUpForm() {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('app-auth-flow', { timeout: 15000 });
  // "No account yet? Sign up" — the sign-in form and the sign-up form both
  // have a password box, so waiting for one of those would have sat happily on
  // the wrong screen.
  await page.locator('button.auth-link:has-text("Sign up")').first().click();
  await page.waitForSelector('input[name="nickname"]', { timeout: 15000 });
  return page;
}

// `.field` as a class token, not a substring: `.field__control` sits between
// the input and the wrapper and would match a contains() test.
const fieldOf = (page, name) => page.locator(`.field:has(input[name="${name}"])`);
const message = (page) => fieldOf(page, 'password').locator('.field__message');

// ---------------------------------------------------------------- the rule
{
  const page = await signUpForm();
  const text = (await message(page).innerText()).trim();

  ok(/at least 8 characters/i.test(text), `the rule is stated before anything is typed: "${text}"`);
  ok(/digit/i.test(text), 'and it mentions the digit');
  ok(!/uppercase|symbol|special/i.test(text),
     'and it does not ask for an uppercase letter or a symbol');
  await page.close();
}

// -------------------------------------------------- one message, not a list
{
  const page = await signUpForm();
  const password = page.locator('input[name="password"]');
  await password.fill('abc');
  await password.blur();
  await page.waitForTimeout(200);
  const text = (await message(page).innerText()).trim();

  ok(/use at least 8 characters/i.test(text), `too short says so plainly: "${text}"`);
  ok(!text.includes(','), 'and it is one thing at a time, not a list');
  await page.close();
}

// ------------------------------------------- what used to be refused is fine
{
  const page = await signUpForm();
  const password = page.locator('input[name="password"]');
  // Lowercase and a digit. The old form refused this for want of an uppercase
  // letter and a symbol.
  await password.fill('all lower case 1');
  await password.blur();
  await page.waitForTimeout(200);
  const field = fieldOf(page, 'password');

  ok(!(await field.getAttribute('class')).includes('field--invalid'),
     'lowercase plus a digit is accepted by the form');
  await page.close();
}

// ------------------------------------ nothing goes red before anything typed
{
  const page = await signUpForm();
  const nickname = page.locator('input[name="nickname"]');
  await nickname.focus();
  // Straight past it, the way somebody does when they want the email box.
  await page.locator('input[name="email"]').first().focus();
  await page.waitForTimeout(200);
  const field = fieldOf(page, 'nickname');

  ok(!(await field.getAttribute('class')).includes('field--invalid'),
     'a field nobody typed in does not turn red just for being left');
  await page.close();
}

// ------------------------------ the way out when the email never turned up
{
  const page = await ctx.newPage();
  await page.route('**/auth/login', (route) => route.fulfill({
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Email is not verified' })
  }));
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('app-auth-flow', { timeout: 15000 });

  await page.waitForSelector('input[name="password"]', { timeout: 15000 });
  await page.locator('input[name="email"]').first().fill('someone@example.com');
  await page.locator('input[name="password"]').fill('correct horse 9');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(600);

  const resend = page.locator('button:has-text("send it again")');
  ok(await resend.count() > 0, 'an unconfirmed account is offered the email again');
  await page.close();
}

await b.close();
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
