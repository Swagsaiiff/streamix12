// STREAMIX Source Provider Interface
// Defines the contract for client-side stream discovery providers.

export class BaseSourceProvider {
  /**
   * @param {string} id Unique identifier for the provider (e.g. 'moviebox', 'direct')
   * @param {string} name Human-readable provider name
   * @param {object} options Provider options
   */
  constructor(id, name, options = {}) {
    if (!id || !name) {
      throw new Error("Source provider must have an id and name");
    }
    this.id = id;
    this.name = name;
    this.options = options;
  }

  /**
   * Whether this provider is configured and enabled.
   * @returns {boolean}
   */
  isAvailable() {
    return true;
  }

  /**
   * Discovers streams for a given item (movie or series episode).
   * @param {object} query Query containing { type, id, title, year, season, episode, sourceUrl, streamUrl }
   * @param {object} options Resolution options (signal, lang, headers, etc.)
   * @returns {Promise<{ sources: Array<object>, diagnostics?: Array<string>, limitation?: string }>}
   */
  async resolveStreams(query, options = {}) {
    throw new Error(`resolveStreams() not implemented on ${this.name}`);
  }
}
