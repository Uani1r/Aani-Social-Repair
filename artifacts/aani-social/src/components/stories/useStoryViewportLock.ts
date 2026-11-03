import { useEffect } from 'react';

export function useStoryViewportLock(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!viewport) return;

    const previousContent = viewport.content;
    const directives = previousContent
      .split(',')
      .map(directive => directive.trim())
      .filter(directive => directive && !/^(initial-scale|minimum-scale|maximum-scale|user-scalable)\s*=/i.test(directive));
    viewport.content = [...directives, 'initial-scale=1', 'minimum-scale=1', 'maximum-scale=1', 'user-scalable=no'].join(', ');

    return () => {
      viewport.content = previousContent;
    };
  }, [enabled]);
}
