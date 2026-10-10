import {ApplicationError} from './errors.mjs';

/** Internal prepared request, not a public execution/admission contract. */
export function normalizeTrainingRequest(value) {
  const invalid = () => {throw new ApplicationError('INVALID_TRAINING_REQUEST');};
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'description,name,preparedSpec,requestId') invalid();
  if (typeof value.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.requestId)) invalid();
  const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  if (typeof value.name !== 'string' || !value.name.isWellFormed()) invalid();
  const name = value.name.trim();
  if (!name || [...name].length > 64 || new TextEncoder().encode(name).length > 256 || controls.test(name)) invalid();
  if (typeof value.description !== 'string' || !value.description.isWellFormed()) invalid();
  const normalized = value.description.replace(/\r\n?/g, '\n');
  const description = normalized.trim();
  if ([...description].length > 2000 || new TextEncoder().encode(description).length > 6000 || controls.test(normalized.replace(/[\n\t]/g, ''))) invalid();
  if (!value.preparedSpec || typeof value.preparedSpec !== 'object' || Array.isArray(value.preparedSpec)) invalid();
  return {requestId: value.requestId, name, description, preparedSpec: value.preparedSpec};
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
  const payload = encode({name: request.name, description: request.description, preparedSpec: request.preparedSpec});
  if (new TextEncoder().encode(payload).length > 65536) throw new ApplicationError('TRAINING_REQUEST_TOO_LARGE');
  return payload;
}
