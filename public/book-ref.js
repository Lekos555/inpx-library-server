(function bookRefGlobal() {
  function bookIdNeedsSafeUrl(id) {
    const s = String(id ?? '');
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
  }

  function encodeBookRef(id) {
    const bytes = new TextEncoder().encode(String(id));
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function decodeBookRef(ref) {
    if (!ref || typeof ref !== 'string') return null;
    try {
      let b64 = ref.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const binary = atob(b64);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const decoded = new TextDecoder().decode(bytes);
      return decoded.length ? decoded : null;
    } catch {
      return null;
    }
  }

  function bookSegment(prefix, id, suffix) {
    const tail = suffix ? (suffix.startsWith('/') ? suffix : `/${suffix}`) : '';
    if (bookIdNeedsSafeUrl(id)) {
      return `${prefix}/b64/${encodeBookRef(id)}${tail}`;
    }
    return `${prefix}/${encodeURIComponent(id)}${tail}`;
  }

  function bookPagePath(id, suffix) {
    return bookSegment('/book', id, suffix || '');
  }

  function readPagePath(id) {
    return bookSegment('/read', id);
  }

  function apiBookPath(id, suffix) {
    return bookSegment('/api/books', id, suffix || '');
  }

  function downloadBookPath(id, query) {
    const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
    return bookSegment('/download', id) + q;
  }

  function apiActionPath(prefix, id) {
    return bookIdNeedsSafeUrl(id) ? `${prefix}/b64/${encodeBookRef(id)}` : `${prefix}/${encodeURIComponent(id)}`;
  }

  function apiReadPath(id) { return apiActionPath('/api/read', id); }
  function apiBookmarkPath(id) { return apiActionPath('/api/bookmarks', id); }
  function apiReadingHistoryPath(id) { return apiActionPath('/api/reading-history', id); }
  function apiSendToEreaderPath(id) { return apiActionPath('/api/send-to-ereader', id); }

  const api = {
    bookIdNeedsSafeUrl, encodeBookRef, decodeBookRef, bookPagePath, readPagePath, apiBookPath, downloadBookPath,
    apiReadPath, apiBookmarkPath, apiReadingHistoryPath, apiSendToEreaderPath
  };
  globalThis.bookRef = api;
  for (const [key, fn] of Object.entries(api)) {
    globalThis[key] = fn;
  }
})();
