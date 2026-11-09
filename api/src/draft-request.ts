import {createHash} from 'node:crypto';

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

export function draftRequest(key: string | undefined, scope: string, body: unknown) {
  if (!key) return {key: null, hash: null}; // Older clients remain compatible.
  if (!/^[a-zA-Z0-9_.:-]{16,160}$/.test(key)) throw new Error('invalid idempotency-key');
  return {
    key: createHash('sha256').update(scope + '\n' + key).digest('hex'),
    hash: createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex'),
  };
}
