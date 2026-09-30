import JSDOMEnvironment from 'jest-environment-jsdom';

/**
 * The scaffold's jsdom environment with Node's URL and URLSearchParams (jsdom's lack canParse and size). `jsdom` gives
 * setLocation() the instance: jsdom cannot navigate, so window.location cannot be assigned.
 */
export default class Environment extends JSDOMEnvironment {
  constructor(...args: ConstructorParameters<typeof JSDOMEnvironment>) {
    super(...args);
    Object.assign(this.global, { URL, URLSearchParams, jsdom: this.dom });
  }
}
