/** Synchronous repository work only; password/network awaits happen outside. */
export function transaction(database, work) {
  return runTransaction(database, 'BEGIN IMMEDIATE', work);
}

export function readTransaction(database, work) {
  return runTransaction(database, 'BEGIN', work);
}

function runTransaction(database, begin, work) {
  database.exec(begin);
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
