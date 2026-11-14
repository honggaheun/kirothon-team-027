export type SignupInput = {
  email: string;
  password: string;
  birthDate: string; // YYYY-MM-DD
  guardianConsent: boolean;
  today?: string; // YYYY-MM-DD
};

export type SignupResult = { ok: true } | { ok: false; reason: string };

export const MIN_PASSWORD_LENGTH = 8; // [R2.3]

const registeredEmails = new Set<string>();

export function registerEmail(email: string): void {
  registeredEmails.add(email.toLowerCase());
}

function isRegistered(email: string): boolean {
  return registeredEmails.has(email.toLowerCase());
}

const no = (tag: string): SignupResult => ({ ok: false, reason: tag.slice(1, -1) });

// 만 나이: 생일이 아직 지나지 않았으면 한 살을 뺀다
function ageOn(birthDate: string, today: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const birthdayPassed = tm > bm || (tm === bm && td >= bd);
  return ty - by - (birthdayPassed ? 0 : 1);
}

export function validateSignup(input: SignupInput): SignupResult {
  const pw = input.password;
  const consent = input.guardianConsent;
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const age = ageOn(input.birthDate, today);

  if (!input.email.includes('@')) return no('[R1.1]')
  if (isRegistered(input.email)) return no('[R1.2]')
  if (!/[a-z]/i.test(pw)) return no('[R2.1]')
  if (!/\d/.test(pw)) return no('[R2.2]')
  if (pw.length < MIN_PASSWORD_LENGTH) return no('[R2.3]')
  if (age < 14 && !consent) return no('[R3.1]')

  return { ok: true };
}
