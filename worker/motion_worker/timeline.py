"""Build the word-level timeline from the real narration alignment. Nothing here assumes a fixed episode length."""
import re
from pythainlp.tokenize import word_tokenize

PUNCT = re.compile(r'[\.\?\!…,"“”\'\(\)\[\]]')


def flatten_alignment(align, offset=0.0):
    return (''.join(align['characters']),
            [s + offset for s in align['character_start_times_seconds']],
            [e + offset for e in align['character_end_times_seconds']])


def build_timeline(segments, text, starts, ends):
    """segments: [{id,text}] in order; text/starts/ends: character alignment of the spoken text."""
    out, pos = [], 0
    n = len(text)
    for si, seg in enumerate(segments):
        stext = seg['text']
        i = text.find(stext, pos)
        if i < 0:  # fall back to a whitespace-insensitive search
            compact = re.sub(r'\s+', '', stext)
            j, k, i = pos, 0, -1
            while j < n and k < len(compact):
                if text[j].isspace():
                    j += 1
                    continue
                if text[j] == compact[k]:
                    if i < 0:
                        i = j
                    k += 1
                else:
                    k, i = 0, -1
                j += 1
            if i < 0:
                raise ValueError(f'segment {seg["id"]} not found in narration alignment')
            jend = j
        else:
            jend = i + len(stext)
        clean = PUNCT.sub(' ', text[i:jend])
        phrases = []
        for m in re.finditer(r'\S+', clean):
            ph = m.group()
            a0 = i + m.start()
            words, q = [], a0
            for tok in word_tokenize(ph, engine='newmm'):
                a, b = q, q + len(tok)
                q = b
                if tok.strip():
                    words.append({'w': tok, 's': round(starts[a], 3), 'e': round(ends[b - 1], 3)})
            if words:
                phrases.append({'text': ph, 's': words[0]['s'], 'e': words[-1]['e'], 'words': words})
        if not phrases:
            raise ValueError(f'segment {seg["id"]} produced no words')
        out.append({'id': seg['id'], 's': phrases[0]['s'], 'e': phrases[-1]['e'], 'phrases': phrases})
        pos = jend
    return out


def word_time(timeline, seg, word, n=0):
    S = {s['id']: s for s in timeline}[seg]
    words = [w for p in S['phrases'] for w in p['words']]
    exact = [w for w in words if w['w'] == word]
    if len(exact) > n:
        return exact[n]['s'], True
    # a phrase spanning several tokens: match on the text with spaces/punctuation removed
    strip = lambda x: re.sub(r'[\s\.\?\!…,"“”\'\(\)\[\]:;\-–—]', '', x)
    joined, owner = '', []
    for i, w in enumerate(words):
        nw = strip(w['w']); joined += nw; owner += [i] * len(nw)
    q = strip(word)
    if q:
        idx, start = -1, 0
        for _ in range(n + 1):
            idx = joined.find(q, start)
            if idx < 0:
                break
            start = idx + 1
        if idx >= 0:
            return words[owner[idx]]['s'], True
    for exact in (True, False):
        k = 0
        for p in S['phrases']:
            for w in p['words']:
                if (w['w'] == word) if exact else (word in w['w'] or w['w'] in word):
                    if k == n:
                        return w['s'], True
                    k += 1
    return S['s'], False


def resolve_cues(timeline, sfx_list):
    S = {s['id']: s for s in timeline}
    cues, misses = [], []
    for fx in sfx_list:
        for c in fx['cues']:
            if c.get('word'):
                t, ok = word_time(timeline, c['seg'], c['word'], c.get('n', 0))
                if not ok:
                    misses.append({'sfx': fx['id'], 'seg': c['seg'], 'word': c['word']})
            elif c.get('at') == 'end':
                t = S[c['seg']]['e']
            else:
                t = S[c['seg']]['s']
            cues.append({'sfx': fx['id'], 't': round(max(0.0, t + c.get('offset', 0)), 3), 'gain': c.get('gain', 0.8)})
    cues.sort(key=lambda x: x['t'])
    return cues, misses


def srt(timeline, end):
    def ts(x):
        ms = int(round(x * 1000))
        return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'
    phrases = [p for s in timeline for p in s['phrases']]
    lines = []
    for i, p in enumerate(phrases):
        nxt = phrases[i + 1]['s'] if i + 1 < len(phrases) else end
        stop = min(nxt, p['e'] + 0.9)
        lines.append(f'{i + 1}\n{ts(p["s"])} --> {ts(stop)}\n{p["text"]}\n')
    return '\n'.join(lines)
