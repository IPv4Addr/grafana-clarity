import JSDOMEnvironment from 'jest-environment-jsdom';

/**
 * The scaffold's jsdom environment with Node's URL and URLSearchParams (jsdom's lack canParse and size), and the
 * Response and (De)CompressionStream that jsdom lacks (share links). `jsdom` gives
 * setLocation() the instance: jsdom cannot navigate, so window.location cannot be assigned.
 */
export default class Environment extends JSDOMEnvironment {
  constructor(...args: ConstructorParameters<typeof JSDOMEnvironment>) {
    super(...args);
    Object.assign(this.global, {
      URL,
      URLSearchParams,
      Response,
      CompressionStream,
      DecompressionStream,
      jsdom: this.dom,
    });
  }
}
