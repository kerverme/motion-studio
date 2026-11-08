"""Scene art written by the LLM, for this one story: a tiny drawing toolkit plus a locked-down way to run the code it writes.

The model writes `art` (helper functions shared by the episode, e.g. a monkey, a temple, a jeep drawn with shapes) and, per
scene, `def draw(c, t, p)` (t = seconds into the scene, p = 0..1 progress). The code never touches Pillow or Python itself:

* validate() parses it with `ast` and accepts only a small subset (no imports, no while, no classes, no dunder/private
  attributes, only toolkit methods and a few list/dict methods, loops at most 2 deep, small constants, no `**` with big exponents);
* run() executes it with a restricted builtins table, a shape budget per frame and a wall-clock limit per frame.

Everything is drawn from shapes, so the result is "code only" (no image generation) and the visual style engine can restyle it."""
import ast, math, signal, time
from contextvars import ContextVar
from functools import lru_cache

from PIL import Image, ImageDraw

W, H = 1080, 1920
SS = 3                      # supersampling of each shape's own tile (cheap anti-aliasing)
MAX_SHAPES = 3500           # per frame
FRAME_SECONDS = 2.5         # wall clock per frame
MAX_CODE = 9000
_ACTIVE_BUDGET = ContextVar('art_frame_budget', default=None)
NAMES = {'white': (255, 255, 255), 'black': (20, 18, 30), 'red': (230, 70, 70), 'orange': (250, 150, 50), 'yellow': (255, 214, 70),
         'green': (90, 190, 110), 'teal': (70, 190, 190), 'blue': (80, 140, 230), 'purple': (150, 100, 220), 'pink': (255, 140, 190),
         'brown': (140, 96, 64), 'tan': (222, 184, 135), 'gray': (150, 150, 160), 'sky': (150, 210, 250), 'cream': (255, 244, 224)}


class ArtError(Exception):
    pass


# ------------------------------------------------------------------------------------------------ helpers visible to the code
def _clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def _lerp(a, b, x):
    return a + (b - a) * x


def _ease(x):                                # ease in-out
    x = _clamp(x)
    return x * x * (3 - 2 * x)


def _ease_out(x):
    x = _clamp(x)
    return 1 - (1 - x) ** 3


def _osc(t, period=1.0, amp=1.0):
    return math.sin(t * 6.2831853 / max(0.05, period)) * amp


def _pingpong(t, period=1.0):
    x = (t / max(0.05, period)) % 2
    return x if x <= 1 else 2 - x


def _rnd(i, k=0):
    v = math.sin(i * 127.1 + k * 311.7) * 43758.5453
    return v - math.floor(v)


def _noise(x, k=0):
    i = math.floor(x)
    f = x - i
    f = f * f * (3 - 2 * f)
    return _rnd(i, k) * (1 - f) + _rnd(i + 1, k) * f


def col(c, alpha=None):
    if isinstance(c, str):
        if c in NAMES:
            c = NAMES[c]
        elif c.startswith('#') and len(c) in (4, 7):
            h = c[1:]
            h = ''.join(ch * 2 for ch in h) if len(h) == 3 else h
            c = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
        else:
            raise ArtError(f'unknown colour {c!r}')
    if not isinstance(c, (tuple, list)) or len(c) < 3:
        raise ArtError(f'bad colour {c!r}')
    c = tuple(int(_clamp(float(v), 0, 255)) for v in c[:3])
    return c


def _mix(a, b, x=0.5):
    a, b = col(a), col(b)
    return tuple(int(_lerp(a[i], b[i], x)) for i in range(3))


def _shade(c, k):                            # k > 0 lighter, k < 0 darker
    c = col(c)
    return tuple(int(_clamp(v + (255 - v) * k if k > 0 else v * (1 + k), 0, 255)) for v in c)


def _rgb(r, g, b):
    return (r, g, b)


def _safe_range(*a):
    a = [int(v) for v in a]
    r = range(*a)
    if len(r) > 300:
        raise ArtError('range() too long (max 300)')
    return r


# ------------------------------------------------------------------------------------------------ canvas
class Canvas:
    """`c` in the model's code. All coordinates are pixels on the 1080 x 1920 frame (origin top-left)."""

    def __init__(self, img, hooks=None):
        self._im = img
        self._m = [(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)]
        self._n = 0
        self._hooks = hooks or {}
        self.w, self.h = img.size
        self.mood, self.talk, self.wave, self.pose = 'normal', 0.0, 0.0, 'stand'

    # --- transforms
    def push(self):
        self._m.append(self._m[-1])
        if len(self._m) > 24:
            raise ArtError('push() nested too deep')

    def pop(self):
        if len(self._m) > 1:
            self._m.pop()

    def move(self, x, y):
        a, b, c, d, e, f = self._m[-1]
        self._m[-1] = (a, b, c, d, a * x + c * y + e, b * x + d * y + f)

    def rotate(self, deg):
        r = math.radians(deg)
        s, k = math.sin(r), math.cos(r)
        a, b, c, d, e, f = self._m[-1]
        self._m[-1] = (a * k + c * s, b * k + d * s, -a * s + c * k, -b * s + d * k, e, f)

    def scale(self, sx, sy=None):
        sy = sx if sy is None else sy
        a, b, c, d, e, f = self._m[-1]
        self._m[-1] = (a * sx, b * sx, c * sy, d * sy, e, f)

    def _tp(self, pts):
        a, b, c, d, e, f = self._m[-1]
        return [(a * x + c * y + e, b * x + d * y + f) for x, y in pts]

    def _k(self):                            # current scale factor, for stroke widths
        a, b = self._m[-1][0], self._m[-1][1]
        return math.hypot(a, b) or 1.0

    # --- painting core: draw one shape as a supersampled mask in its own small tile, then blend it
    def _paint(self, pts, colour, alpha, fill=True, width=0.0, closed=True):
        self._n += 1
        budget = _ACTIVE_BUDGET.get()
        if budget is not None:
            budget['shapes'] += 1
            if time.monotonic() >= budget['deadline']:
                raise ArtError('scene took too long to draw')
        if (budget['shapes'] if budget is not None else self._n) > MAX_SHAPES:
            raise ArtError('too many shapes in one frame (max %d)' % MAX_SHAPES)
        if len(pts) < 2 or any(not (math.isfinite(x) and math.isfinite(y)) for x, y in pts):
            return
        pad = width / 2 + 3
        x0 = max(0, int(math.floor(min(p[0] for p in pts) - pad))); y0 = max(0, int(math.floor(min(p[1] for p in pts) - pad)))
        x1 = min(self.w, int(math.ceil(max(p[0] for p in pts) + pad))); y1 = min(self.h, int(math.ceil(max(p[1] for p in pts) + pad)))
        if x1 <= x0 or y1 <= y0:
            return
        w, h = x1 - x0, y1 - y0
        ss = SS if w * h <= 1_500_000 else 1
        m = Image.new('L', (w * ss, h * ss), 0)
        d = ImageDraw.Draw(m)
        q = [((x - x0) * ss, (y - y0) * ss) for x, y in pts]
        if fill:
            d.polygon(q, fill=255)
        else:
            lw = max(1, int(round(width * ss)))
            d.line(q + ([q[0]] if closed else []), fill=255, width=lw, joint='curve')
            for px, py in ([] if closed else [q[0], q[-1]]):      # round caps
                r = lw / 2
                d.ellipse((px - r, py - r, px + r, py + r), fill=255)
        if ss > 1:
            m = m.resize((w, h), Image.BOX)
        al = _clamp(float(alpha))
        if al < 1:
            m = m.point(lambda v: int(v * al))
        tile = Image.new('RGBA', (w, h), col(colour) + (255,))
        tile.putalpha(m)
        self._im.alpha_composite(tile, (x0, y0))

    @staticmethod
    def _ring(cx, cy, rx, ry, n=56):
        return [(cx + math.cos(i * 6.2831853 / n) * rx, cy + math.sin(i * 6.2831853 / n) * ry) for i in range(n)]

    # --- shapes (every shape takes the current transform into account)
    def rect(self, x, y, w, h, color, r=0, alpha=1.0, outline=None, ow=6):
        r = min(abs(r), abs(w) / 2, abs(h) / 2)
        if r < 1:
            pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
        else:
            pts = []
            for cx, cy, a0 in ((x + w - r, y + r, -90), (x + w - r, y + h - r, 0), (x + r, y + h - r, 90), (x + r, y + r, 180)):
                pts += [(cx + math.cos(math.radians(a0 + k * 15)) * r, cy + math.sin(math.radians(a0 + k * 15)) * r) for k in range(7)]
        self.poly(pts, color, alpha, outline, ow)

    def circle(self, x, y, r, color, alpha=1.0, outline=None, ow=6):
        self.poly(self._ring(x, y, r, r), color, alpha, outline, ow)

    def ellipse(self, x, y, rx, ry, color, rot=0, alpha=1.0, outline=None, ow=6):
        pts = self._ring(0, 0, rx, ry)
        if rot:
            s, k = math.sin(math.radians(rot)), math.cos(math.radians(rot))
            pts = [(px * k - py * s + x, px * s + py * k + y) for px, py in pts]
        else:
            pts = [(px + x, py + y) for px, py in pts]
        self.poly(pts, color, alpha, outline, ow)

    def poly(self, points, color, alpha=1.0, outline=None, ow=6):
        pts = self._tp([(float(p[0]), float(p[1])) for p in points[:200]])
        self._paint(pts, color, alpha)
        if outline is not None:
            self._paint(pts, outline, alpha, fill=False, width=ow * self._k(), closed=True)

    def line(self, x0, y0, x1, y1, color, w=8, alpha=1.0):
        self.path([(x0, y0), (x1, y1)], color, w, alpha)

    def path(self, points, color, w=8, alpha=1.0, smooth=False, closed=False):
        pts = [(float(p[0]), float(p[1])) for p in points[:200]]
        if smooth and len(pts) > 2:
            for _ in range(2):               # Chaikin corner cutting
                nxt = [pts[0]]
                for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                    nxt += [(ax * .75 + bx * .25, ay * .75 + by * .25), (ax * .25 + bx * .75, ay * .25 + by * .75)]
                pts = nxt + [pts[-1]]
        self._paint(self._tp(pts), color, alpha, fill=False, width=w * self._k(), closed=closed)

    def arc(self, x, y, r, a0, a1, color, w=8, alpha=1.0):
        n = max(4, int(abs(a1 - a0) / 6))
        self.path([(x + math.cos(math.radians(a0 + (a1 - a0) * i / n)) * r, y + math.sin(math.radians(a0 + (a1 - a0) * i / n)) * r) for i in range(n + 1)], color, w, alpha)

    def blob(self, x, y, rx, ry, color, seed=0, bump=0.14, alpha=1.0, outline=None, ow=6):
        """a soft irregular shape: bushes, clouds, fur, rocks"""
        n = 40
        pts = []
        for i in range(n):
            a = i * 6.2831853 / n
            k = 1 + (_noise(a * 2.2 + seed * 7.1, seed) - 0.5) * 2 * bump
            pts.append((x + math.cos(a) * rx * k, y + math.sin(a) * ry * k))
        self.poly(pts, color, alpha, outline, ow)

    def grad(self, top, bottom, y0=0, y1=None):
        """a vertical gradient band (use it first, as the sky/wall of the scene)"""
        y1 = self.h if y1 is None else y1
        a, b = col(top), col(bottom)
        y0, y1 = int(_clamp(y0, 0, self.h)), int(_clamp(y1, 0, self.h))
        if y1 <= y0:
            return
        band = Image.new('RGBA', (1, y1 - y0))
        for yy in range(y1 - y0):
            f = yy / max(1, y1 - y0 - 1)
            band.putpixel((0, yy), tuple(int(_lerp(a[i], b[i], f)) for i in range(3)) + (255,))
        self._im.alpha_composite(band.resize((self.w, y1 - y0)), (0, y0))

    def text(self, x, y, s, size=64, color='white', stroke=6):
        put, text_img = self._hooks.get('put'), self._hooks.get('text_img')
        if put and text_img:
            a = self._m[-1]
            put(self._im, text_img(str(s)[:60], int(_clamp(size * self._k(), 12, 220)), 800, col(color), int(stroke), (30, 20, 60)), a[0] * x + a[2] * y + a[4], a[1] * x + a[3] * y + a[5])

    # --- characters of the episode's cast and the channel mascot (drawn by the engine, with their uploaded look)
    def person(self, who, x, y, size=240, mood='normal', talk=0.0, pose='stand', wave=0.0):
        fn = self._hooks.get('person')
        if fn:
            (px, py), = self._tp([(x, y)])
            fn(self._im, who, px, py, size * self._k(), mood, talk, pose, wave)

    def cue(self, word):
        """seconds from the start of this scene to when `word` is spoken in the narration (use it to time reveals)"""
        fn = self._hooks.get('cue')
        return float(fn(word)) if fn else 0.0

    def cat(self, x, y, size=160, mood='normal', talk=0.0):
        fn = self._hooks.get('cat')
        if fn:
            (px, py), = self._tp([(x, y)])
            fn(self._im, px, py, size * self._k(), mood, talk)


METHODS = {n for n in dir(Canvas) if not n.startswith('_')} | {'w', 'h', 'mood', 'talk', 'wave', 'pose'}
LIST_METHODS = {'append', 'extend', 'pop', 'get', 'items', 'keys', 'values', 'index', 'count', 'sort', 'insert', 'reverse', 'join', 'upper', 'lower'}
ALLOWED_ATTRS = METHODS | LIST_METHODS
GLOBALS = {
    'sin': lambda d: math.sin(math.radians(d)), 'cos': lambda d: math.cos(math.radians(d)), 'tan': lambda d: math.tan(math.radians(d)),
    'atan2': lambda y, x: math.degrees(math.atan2(y, x)), 'sqrt': lambda v: math.sqrt(max(0.0, v)), 'hypot': math.hypot, 'pi': math.pi,
    'floor': math.floor, 'ceil': math.ceil, 'lerp': _lerp, 'clamp': _clamp, 'ease': _ease, 'ease_out': _ease_out, 'osc': _osc,
    'pingpong': _pingpong, 'rnd': _rnd, 'noise': _noise, 'mix': _mix, 'shade': _shade, 'rgb': _rgb,
    'range': _safe_range, 'len': len, 'min': min, 'max': max, 'abs': abs, 'round': round, 'int': int, 'float': float, 'sum': sum,
    'enumerate': enumerate, 'zip': zip, 'list': list, 'tuple': tuple, 'sorted': sorted, 'reversed': reversed, 'bool': bool, 'str': str,
    'True': True, 'False': False, 'None': None,
}
OK_NODES = (ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Return, ast.Assign, ast.AugAssign, ast.Expr, ast.If, ast.For, ast.Break,
            ast.Continue, ast.Pass, ast.Call, ast.Name, ast.Load, ast.Store, ast.Constant, ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.IfExp,
            ast.Tuple, ast.List, ast.Dict, ast.Subscript, ast.Slice, ast.Attribute, ast.ListComp, ast.GeneratorExp, ast.comprehension, ast.keyword,
            ast.Lambda, ast.JoinedStr, ast.FormattedValue, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow, ast.USub, ast.UAdd,
            ast.Not, ast.And, ast.Or, ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.In, ast.NotIn, ast.Is, ast.IsNot)


def defined_names(code):
    try:
        tree = ast.parse(code or '')
    except SyntaxError:
        return set()
    return {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)} | {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}


def validate(code, label='code', extra=()):
    """Return a list of problems (empty = safe to run). `extra`: names the shared art code defines."""
    if not isinstance(code, str):
        return [f'{label}: must be a string']
    if len(code) > MAX_CODE:
        return [f'{label}: longer than {MAX_CODE} characters']
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f'{label}: syntax error line {e.lineno}: {e.msg}']
    local = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
    local |= {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    local |= {a.arg for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.Lambda)) for a in n.args.args}
    local |= set(extra)
    errs = []
    # Compilation must not execute user loops/calls before the frame timeout starts.
    # Helpers plus literal palettes/constants are enough for shared scene and portrait art.
    for stmt in tree.body:
        if isinstance(stmt, ast.FunctionDef):
            for default in stmt.args.defaults + [x for x in stmt.args.kw_defaults if x is not None]:
                try:
                    ast.literal_eval(default)
                except (ValueError, TypeError, SyntaxError):
                    errs.append(f'{label}: function defaults must be literals')
        elif isinstance(stmt, ast.Assign):
            try:
                ast.literal_eval(stmt.value)
            except (ValueError, TypeError, SyntaxError):
                errs.append(f'{label}: top-level constants must be literals')
        else:
            errs.append(f'{label}: top level accepts only functions and literal constants')

    def walk(node, depth):
        if not isinstance(node, OK_NODES):
            errs.append(f'{label}: line {getattr(node, "lineno", "?")}: {type(node).__name__} is not allowed')
            return
        if isinstance(node, (ast.For, ast.ListComp, ast.GeneratorExp)):
            depth += 1
            if depth > 2:
                errs.append(f'{label}: line {node.lineno}: loops nested more than 2 deep')
        if isinstance(node, ast.Name):
            if node.id.startswith('_') or (node.id not in GLOBALS and node.id not in local and node.id not in ('c', 't', 'p')):
                errs.append(f'{label}: line {node.lineno}: name "{node.id}" is not available')
        if isinstance(node, ast.Attribute) and (node.attr.startswith('_') or node.attr not in ALLOWED_ATTRS):
            errs.append(f'{label}: line {node.lineno}: ".{node.attr}" is not available (canvas methods: {", ".join(sorted(METHODS - {"w", "h"}))})')
        if isinstance(node, ast.Constant) and ((isinstance(node.value, (int, float)) and abs(node.value) > 1_000_000) or (isinstance(node.value, str) and len(node.value) > 200)):
            errs.append(f'{label}: line {node.lineno}: constant too large')
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Pow) and not (isinstance(node.right, ast.Constant) and isinstance(node.right.value, int) and 0 <= node.right.value <= 4):
            errs.append(f'{label}: line {node.lineno}: "**" only with a small integer exponent (0-4)')
        if isinstance(node, ast.FunctionDef) and (node.decorator_list or node.args.vararg or node.args.kwarg):
            errs.append(f'{label}: line {node.lineno}: no decorators, *args or **kwargs')
        for ch in ast.iter_child_nodes(node):
            walk(ch, depth)

    walk(tree, 0)
    return errs[:12]


class _Timeout(Exception):
    pass


def _alarm(signum, frame):
    raise _Timeout()


def compile_art(art, code, label='scene'):
    """Compile the shared `art` + one scene's code into a draw(c, t, p) callable. Raises ArtError with a clear message."""
    errs = validate(art or '', 'art') + validate(code or '', label, defined_names(art))
    if errs:
        raise ArtError('; '.join(errs[:6]))
    ns = {'__builtins__': {}, **GLOBALS}
    try:
        exec(compile(art or '', 'art', 'exec'), ns)
        exec(compile(code, label, 'exec'), ns)
    except Exception as e:
        raise ArtError(f'{label}: {type(e).__name__}: {e}')
    fn = ns.get('draw')
    if not callable(fn):
        raise ArtError(f'{label}: define def draw(c, t, p):')
    return fn


def run(fn, img, t, p, hooks=None, canvas=None):
    """Draw with a shared nested shape/time budget; portrait calls cannot reset it."""
    c = canvas or Canvas(img, hooks)
    budget = _ACTIVE_BUDGET.get()
    token = None
    if budget is None:
        budget = {'shapes': 0, 'deadline': time.monotonic() + FRAME_SECONDS}
        token = _ACTIVE_BUDGET.set(budget)
    use_alarm = token is not None and hasattr(signal, 'setitimer')
    old_timer = (0.0, 0.0)
    alarm_started = time.monotonic()
    try:
        if use_alarm:
            old = signal.signal(signal.SIGALRM, _alarm)
            old_timer = signal.getitimer(signal.ITIMER_REAL)
            wait = min(FRAME_SECONDS, old_timer[0]) if old_timer[0] > 0 else FRAME_SECONDS
            signal.setitimer(signal.ITIMER_REAL, wait)
    except ValueError:                       # not main thread: shape and elapsed budgets still apply
        use_alarm = False
    try:
        if time.monotonic() >= budget['deadline']:
            raise ArtError('scene took too long to draw')
        fn(c, float(t), float(p))
    except _Timeout:
        raise ArtError('scene took too long to draw')
    except ArtError:
        raise
    except Exception as e:
        raise ArtError(f'{type(e).__name__}: {e}')
    finally:
        if use_alarm:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old)
            if old_timer[0] > 0:
                signal.setitimer(signal.ITIMER_REAL, max(0.001, old_timer[0] - (time.monotonic() - alarm_started)), old_timer[1])
        if token is not None:
            _ACTIVE_BUDGET.reset(token)


@lru_cache(maxsize=32)
def compile_portrait(code):
    """A reference-specific silhouette/face, with no background or recursive actors."""
    errs = validate(code, 'portrait')
    if errs:
        raise ArtError('; '.join(errs[:6]))
    tree = ast.parse(code)
    if any(isinstance(n, ast.Attribute) and n.attr in ('person', 'cat', 'grad') for n in ast.walk(tree)):
        raise ArtError('portrait: person, cat and grad are not allowed; draw only the character with shapes')
    return compile_art('', code, 'portrait')


def draw_portrait(img, code, cx, cy, size, t, mood='normal', talk=0.0, wave=0.0, pose='stand', alpha=1.0):
    """Canonical head center (0,0), width 200, feet y=370; transparent, reused in scene/cover."""
    fn = compile_portrait(code)
    target = Image.new('RGBA', img.size, (0, 0, 0, 0)) if alpha < 1 else img
    c = Canvas(target)
    c.move(float(cx), float(cy))
    c.scale(max(10, float(size)) / 200.0)
    c.mood, c.talk, c.wave, c.pose = str(mood), _clamp(float(talk)), _clamp(float(wave)), str(pose)
    run(fn, target, t, c.talk, canvas=c)
    if alpha < 1:
        target.putalpha(target.getchannel('A').point(lambda a: int(a * _clamp(alpha))))
        img.alpha_composite(target)
