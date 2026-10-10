import {ApplicationError} from './errors.mjs';

/** Normalize task labels after the shared training submission contract is parsed. */
export function normalizeTrainingRequest(value) {
  const invalid = () => {throw new ApplicationError('INVALID_TRAINING_REQUEST');};
  const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  if (typeof value.name !== 'string' || !value.name.isWellFormed()) invalid();
  const name = value.name.trim();
  if (!name || [...name].length > 64 || new TextEncoder().encode(name).length > 256 || controls.test(name)) invalid();
  if (typeof value.description !== 'string' || !value.description.isWellFormed()) invalid();
  const normalized = value.description.replace(/\r\n?/g, '\n');
  const description = normalized.trim();
  if ([...description].length > 2000 || new TextEncoder().encode(description).length > 6000 || controls.test(normalized.replace(/[\n\t]/g, ''))) invalid();
  return {...value, name, description};
}

/** Stable JSON identity: key order is irrelevant, array/argv order is not. */
export function canonicalTrainingPayload(request) {
  const ancestors = new Set();
  function encode(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== 'object' || ancestors.has(value)) throw new ApplicationError('INVALID_TRAINING_REQUEST');
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ApplicationError('INVALID_TRAINING_REQUEST');
    ancestors.add(value);
    const result = Array.isArray(value) ? '[' + Array.from(value, encode).join(',') + ']'
      : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + encode(value[key])).join(',') + '}';
    ancestors.delete(value);
    return result;
  }
  const {requestId, ...submission} = request;
  const payload = encode(submission);
  if (new TextEncoder().encode(payload).length > 65536) throw new ApplicationError('TRAINING_REQUEST_TOO_LARGE');
  return payload;
}
