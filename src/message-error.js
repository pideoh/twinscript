// An error that carries a UI message key (see src/locales/) and its placeholder values, so modules
// without UI access can report errors that the app translates with t(err.key, err.params).
// `message` keeps the key and values for logs and tests.
export class MessageError extends Error {
  constructor(key, params) {
    super(params ? `${key} ${JSON.stringify(params)}` : key);
    this.key = key;
    this.params = params;
  }
}
