// What can go wrong with a transactions feed (`app-tx-feed`) at a given window:
// the page scrolling sideways, the feed or its bar running out of where it sits,
// and inside a row, a part sticking out of the row, the ticker out of its cell,
// or one part lying on another. Returns the problems found, in words.
//
// `scope` is a selector for the elements that hold a feed each (the pool
// page's section, an archive round), checked one by one.
export function feedLayoutIssues(page, scope) {
  return page.evaluate((scope) => {
    const issues = [];
    const box = (el) => el.getBoundingClientRect();
    const inside = (a, b, slack = 1) => a.left >= b.left - slack && a.right <= b.right + slack && a.top >= b.top - slack && a.bottom <= b.bottom + slack;
    const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) issues.push(`page scrolls sideways by ${doc.scrollWidth - doc.clientWidth}px`);
    for (const holder of document.querySelectorAll(scope)) {
      const name = holder.querySelector('.round__id')?.textContent?.trim() ?? scope;
      // `app-tx-feed` since 2026-10-05; before it the pool page held the same window itself.
      const feed = holder.querySelector('app-tx-feed') ?? holder.querySelector('.buy-window');
      if (!feed) continue;
      if (!inside(box(feed), box(holder))) issues.push(`${name}: the feed runs out of its place`);
      const list = feed.querySelector('.buy-list');
      const rail = feed.querySelector('.buy-rail');
      if (rail) {
        if (!inside(box(rail), box(feed))) issues.push(`${name}: the scrollbar runs out of the feed`);
        if (box(rail).left < box(list).right - 1) issues.push(`${name}: the scrollbar lies over the rows`);
      }
      const windowBox = box(feed.querySelector('.buy-feed'));
      for (const row of feed.querySelectorAll('.buy-row')) {
        const rb = box(row);
        if (rb.bottom < windowBox.top || rb.top > windowBox.bottom) continue;
        if (rb.right > box(list).right + 1 || rb.left < box(list).left - 1) issues.push(`${name}: a row runs out of the list`);
        const parts = [...row.children].filter((c) => getComputedStyle(c).display !== 'none' && box(c).width > 0);
        for (const part of parts) {
          const pb = box(part);
          if (pb.left < rb.left - 1 || pb.right > rb.right + 1) issues.push(`${name}: "${part.className}" sticks out of its row (${Math.round(pb.right - rb.right)}px)`);
        }
        // A cell's box can fit while its text does not: the ticker must end inside its own cell.
        const coinCell = row.querySelector('.buy-row__coin');
        const ticker = coinCell?.querySelector('b');
        if (ticker && box(ticker).right > box(coinCell).right + 1) issues.push(`${name}: the ticker runs out of its cell (${Math.round(box(ticker).right - box(coinCell).right)}px)`);
        // Cut text keeps enough to read: a name cut to a few pixels showed half a letter.
        for (const text of coinCell ? coinCell.children : []) {
          const width = box(text).width;
          if (width > 0 && text.scrollWidth > text.clientWidth + 1 && width < 24) issues.push(`${name}: "${text.textContent.trim()}" is cut to ${Math.round(width)}px`);
        }
        for (let i = 0; i < parts.length; i++) {
          for (let j = i + 1; j < parts.length; j++) {
            const area = overlap(box(parts[i]), box(parts[j]));
            if (area > 2) issues.push(`${name}: "${parts[i].className}" lies on "${parts[j].className}" (${Math.round(area)}px²)`);
          }
        }
      }
    }
    return [...new Set(issues)];
  }, scope);
}

/** The windows a person is likely to have, down to a 320px phone. */
export const FEED_SIZES = [
  [320, 568], [360, 640], [375, 667], [390, 844], [414, 896], [600, 960], [768, 1024],
  [820, 1180], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440]
];
