"""
Proximity — v3 — architecture liseuse
"""

import sys, re, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QTextEdit, QSplashScreen,
    QWidget, QHBoxLayout, QVBoxLayout, QLabel, QPushButton,
)
from PySide6.QtCore import (
    QTimer, Qt, QEvent, QThread, Signal, QPoint, QRect,
)
from PySide6.QtGui import (
    QFont, QFontMetrics, QPainter, QColor, QPen, QPixmap,
    QTextCursor, QTextBlockFormat, QCursor,
)

from app.engine import ProxEngine
from app import config

BADGE_H_PAD    = 6
BADGE_V_PAD    = 2
SPLASH_MIN_MS  = 1500
ASSETS_DIR     = Path(__file__).resolve().parent.parent / "assets"
VIVANT_SIZE    = 6000
CHARS_PER_PAGE = 1500
LINE_H_TYPE    = 1   # QTextBlockFormat.ProportionalHeight


def _rep_color(distance: int) -> QColor:
    """Gradient vert → orange → rouge vif selon la distance."""
    ratio = max(0.0, min(1.0, 1.0 - distance / config.SEUIL_DEFAUT))
    hue   = int(120 * (1.0 - ratio))        # 120 vert → 0 rouge
    val   = int(160 + 60 * ratio)           # 160 (loin/vert) → 220 (proche/rouge vif)
    return QColor.fromHsv(hue, 255, val)


def _tokenize(text: str) -> list[str]:
    return re.findall(r'\S+\s*', text)


# ══════════════════════════════════════════════════════════════════════════════
# Workers
# ══════════════════════════════════════════════════════════════════════════════

class LoadWorker(QThread):
    done = Signal(object)

    def run(self):
        import spacy
        nlp = None
        for model in ('fr_core_news_lg', 'fr_core_news_md', 'fr_core_news_sm'):
            try:
                nlp = spacy.load(model, disable=['parser', 'ner'])
                break
            except OSError:
                continue
        self.done.emit(nlp)


class AnalysisWorker(QThread):
    finished = Signal(list, int)

    def __init__(self, nlp, seuil, profil, text, aid):
        super().__init__()
        self._nlp, self._seuil, self._profil = nlp, seuil, profil
        self._text, self._id = text, aid

    def run(self):
        engine = ProxEngine(self._nlp, self._seuil, self._profil)
        engine.load_text(self._text)
        self.finished.emit(engine.get_repetitions(), self._id)


# ══════════════════════════════════════════════════════════════════════════════
# Overlay
# ══════════════════════════════════════════════════════════════════════════════

class ProxAnnotationOverlay(QWidget):

    def __init__(self, editor: 'ProxPageView'):
        super().__init__(editor.viewport())
        self._editor = editor
        self._word_annots: dict = {}
        self._partner: 'ProxAnnotationOverlay | None' = None
        self._active_from_partner: set = set()

        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground)
        self.setGeometry(editor.viewport().rect())
        self.raise_()
        editor.verticalScrollBar().valueChanged.connect(self.update)
        editor.cursorPositionChanged.connect(self.update)

    def set_partner(self, other: 'ProxAnnotationOverlay'):
        self._partner = other

    def set_badges(self, events: list):
        self._word_annots.clear()
        for offset, forme, distance, direction, rep_idx in events:
            color = _rep_color(distance)
            w = self._word_annots.setdefault(offset, {'forme': forme})
            w[direction] = (distance, rep_idx, color)
        self.update()

    def _notify_partner(self, active: set):
        if self._partner and self._partner._active_from_partner != active:
            self._partner._active_from_partner = active
            self._partner.update()

    def paintEvent(self, event):
        editor     = self._editor
        doc        = editor.document()
        fm         = QFontMetrics(editor.font())
        text_h     = fm.height()
        vp_h       = self.height()
        vp_w       = self.width()
        label_font = QFont(editor.font().family(), config.BADGE_FONT_PT)
        label_fm   = QFontMetrics(label_font)

        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        max_doc_pos = max(0, doc.characterCount() - 1)
        cursor_pos  = editor.textCursor().position()
        mouse_pos   = editor.viewport().mapFromGlobal(QCursor.pos())

        bh             = label_fm.height() + BADGE_V_PAD * 2
        BADGE_OFFSET_Y = 8   # px sous la base du texte

        # ── Phase 1 : calcul des positions de tous les badges ─────────────────
        all_badges = []
        for offset in sorted(self._word_annots.keys()):
            info  = self._word_annots[offset]
            forme = info['forme'].rstrip()

            c1 = QTextCursor(doc)
            c1.setPosition(min(offset, max_doc_pos))
            r1 = editor.cursorRect(c1)

            y_top = r1.top()
            if y_top + r1.height() < 0 or y_top > vp_h:
                continue

            badge_y = int(y_top + text_h + BADGE_OFFSET_Y)
            # Badge partiellement invisible en bas → le monter au-dessus de la ligne
            if badge_y + bh > vp_h:
                badge_y = int(y_top - bh - 4)
            if badge_y < 0:
                continue

            cur_x = r1.left()
            for key in ('avant', 'après'):
                if key not in info:
                    continue
                dist, rep_idx, color = info[key]
                label = f'←{dist}' if key == 'avant' else f'{dist}→'
                bw    = label_fm.horizontalAdvance(label) + BADGE_H_PAD * 2
                all_badges.append({
                    'x': cur_x, 'y': badge_y, 'w': bw, 'h': bh,
                    'label': label, 'color': color, 'rep_idx': rep_idx,
                    'offset': offset, 'forme_len': len(info['forme']),
                })
                cur_x += bw + 4

        # ── Phase 2 : survol badge (x ET y) et curseur ────────────────────────
        active_reps: set = set()
        for b in all_badges:
            br = QRect(b['x'], b['y'], b['w'], b['h'])
            if br.contains(mouse_pos):
                active_reps.add(b['rep_idx'])
            if b['offset'] <= cursor_pos < b['offset'] + b['forme_len']:
                active_reps.add(b['rep_idx'])

        self._notify_partner(active_reps)
        all_active = active_reps | self._active_from_partner

        # ── Phase 3 : filets discrets entre lignes ────────────────────────────
        try:
            top_cur = editor.cursorForPosition(QPoint(0, 0))
        except Exception:
            return
        block = top_cur.block()
        if block.previous().isValid():
            block = block.previous()

        rule_pen = QPen(QColor(160, 160, 160, 22), 1)
        done = False
        while block.isValid() and not done:
            layout = block.layout()
            if layout:
                for i in range(layout.lineCount()):
                    line = layout.lineAt(i)
                    if not line.isValid():
                        continue
                    cur = QTextCursor(doc)
                    cur.setPosition(min(
                        block.position() + max(0, line.textStart()), max_doc_pos
                    ))
                    rect  = editor.cursorRect(cur)
                    y_top = rect.top()
                    if y_top > vp_h:
                        done = True
                        break
                    if y_top + rect.height() >= 0:
                        painter.setPen(rule_pen)
                        painter.drawLine(0, y_top + text_h + 2, vp_w, y_top + text_h + 2)
            block = block.next()

        # ── Phase 4 : dessin des badges ───────────────────────────────────────
        painter.setFont(label_font)
        for b in all_badges:
            badge_rect = QRect(b['x'], b['y'], b['w'], b['h'])
            is_active  = b['rep_idx'] in all_active

            # Fond : transparent inactif, opaque actif
            bg = QColor(b['color'])
            bg.setAlpha(215 if is_active else 50)
            painter.fillRect(badge_rect, bg)

            # Bordure : toujours visible pour reconnaître la couleur inactif aussi
            border = QColor(b['color'])
            border.setAlpha(215 if is_active else 170)
            painter.setPen(QPen(border, 1))
            painter.drawRect(badge_rect)

            # Texte : blanc sur actif, foncé sur inactif
            if is_active:
                painter.setPen(QColor(255, 255, 255))
            else:
                painter.setPen(QColor(20, 20, 20, 210))
            painter.drawText(badge_rect, Qt.AlignmentFlag.AlignCenter, b['label'])


# ══════════════════════════════════════════════════════════════════════════════
# Page (éditeur individuel)
# ══════════════════════════════════════════════════════════════════════════════

class ProxPageView(QTextEdit):

    def __init__(self, placeholder: str = "", parent=None):
        super().__init__(parent)
        self._dp: 'ProxDoublePage | None' = None
        self._is_left: bool = False

        self.setFont(QFont(config.FONT_FAMILY, config.FONT_SIZE_PT))
        self.setStyleSheet(
            "QTextEdit { background: white; border: none; color: #1a1a1a; }"
        )
        self.setViewportMargins(config.MARGIN_PX, 48, config.MARGIN_PX, 48)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        if placeholder:
            self.setPlaceholderText(placeholder)

        self.overlay = ProxAnnotationOverlay(self)
        self.viewport().setMouseTracking(True)
        self.viewport().installEventFilter(self)

    def set_dp(self, dp: 'ProxDoublePage', is_left: bool):
        self._dp      = dp
        self._is_left = is_left

    def eventFilter(self, obj, event):
        if obj is self.viewport():
            t = event.type()
            if t == QEvent.Type.Resize:
                self.overlay.setGeometry(self.viewport().rect())
            elif t in (QEvent.Type.MouseMove, QEvent.Type.Leave):
                self.overlay.update()
        return super().eventFilter(obj, event)

    def scrollContentsBy(self, dx, dy):
        self.overlay.update()

    def ensureCursorVisible(self):
        pass

    def wheelEvent(self, event):
        pass

    def keyPressEvent(self, event):
        key = event.key()
        mod = event.modifiers()
        CTRL = Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier

        if bool(mod & CTRL):
            if key == Qt.Key.Key_Right and self._dp:
                self._dp.next_page()
                return
            if key == Qt.Key.Key_Left and self._dp:
                self._dp.prev_page()
                return

        cur = self.textCursor()
        if self._dp and key == Qt.Key.Key_Right and self._is_left and cur.atEnd():
            self._dp.transfer_to_right()
            return
        if self._dp and key == Qt.Key.Key_Left and not self._is_left and cur.position() == 0:
            self._dp.transfer_to_left()
            return

        super().keyPressEvent(event)

    def is_overflowing(self) -> bool:
        """Vrai si le dernier caractère n'est pas visible dans le viewport."""
        doc = self.document()
        n   = doc.characterCount()
        if n <= 1:
            return False
        last_char_pos = n - 2   # -1 pour le séparateur de paragraphe Qt final
        vp   = self.viewport()
        last_visible = self.cursorForPosition(
            QPoint(vp.width() - 1, vp.height() - 1)
        ).position()
        return last_visible < last_char_pos


# ══════════════════════════════════════════════════════════════════════════════
# Double page
# ══════════════════════════════════════════════════════════════════════════════

class ProxDoublePage(QWidget):

    def __init__(self, engine: ProxEngine, parent=None):
        super().__init__(parent)
        self._engine      = engine
        self._analysis_id = 0
        self._worker      = None
        self._reflowing   = False

        self._full_text: str       = ""
        self._full_word_count: int = 0
        self._vivant_start: int    = 0
        self._words: list[str]     = []
        self._right_end: int       = 0

        # Pages gauche et droite
        self._pg = ProxPageView("Collez votre texte ici…", parent=self)
        self._pd = ProxPageView(parent=self)
        self._pg.set_dp(self, is_left=True)
        self._pd.set_dp(self, is_left=False)
        self._pg.overlay.set_partner(self._pd.overlay)
        self._pd.overlay.set_partner(self._pg.overlay)

        # ── Footer ────────────────────────────────────────────────────────────
        self._footer = QWidget()
        self._footer.setFixedHeight(76)
        self._footer.setStyleSheet(
            "background: #d8d8d8; border-top: 1px solid #bbb;"
        )
        foot_lay = QVBoxLayout(self._footer)
        foot_lay.setContentsMargins(20, 6, 20, 6)
        foot_lay.setSpacing(3)

        btn_style = (
            "QPushButton { border: none; background: transparent; "
            "font-size: 24px; color: #444; padding: 0 8px; }"
            "QPushButton:hover { color: #000; }"
            "QPushButton:disabled { color: #bbb; }"
        )
        self._btn_prev = QPushButton("◀")
        self._btn_next = QPushButton("▶")
        for btn in (self._btn_prev, self._btn_next):
            btn.setStyleSheet(btn_style)
            btn.setFixedSize(48, 40)

        self._lbl_stats = QLabel()
        self._lbl_stats.setFont(QFont(config.FONT_FAMILY, 13))
        self._lbl_stats.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._lbl_stats.setStyleSheet("color: #333;")

        self._lbl_info = QLabel(
            "Ctrl+←  page précédente   ·   Ctrl+→  page suivante"
        )
        self._lbl_info.setFont(QFont(config.FONT_FAMILY, 12))
        self._lbl_info.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._lbl_info.setStyleSheet("color: #777;")

        row1 = QHBoxLayout()
        row1.addWidget(self._btn_prev)
        row1.addStretch()
        row1.addWidget(self._lbl_stats)
        row1.addStretch()
        row1.addWidget(self._btn_next)

        foot_lay.addLayout(row1)
        foot_lay.addWidget(self._lbl_info)

        self._btn_prev.clicked.connect(self.prev_page)
        self._btn_next.clicked.connect(self.next_page)

        # ── Layout ────────────────────────────────────────────────────────────
        editors_lay = QHBoxLayout()
        editors_lay.setContentsMargins(24, 24, 24, 8)
        editors_lay.setSpacing(config.PAGE_GUTTER)
        editors_lay.addWidget(self._pg)
        editors_lay.addWidget(self._pd)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        outer.addLayout(editors_lay)
        outer.addWidget(self._footer)

        # ── Timers ────────────────────────────────────────────────────────────
        self._reflow_timer = QTimer(self)
        self._reflow_timer.setSingleShot(True)
        self._reflow_timer.setInterval(0)
        self._reflow_timer.timeout.connect(self._do_reflow)

        self._analysis_timer = QTimer(self)
        self._analysis_timer.setSingleShot(True)
        self._analysis_timer.setInterval(config.DEBOUNCE_MS)
        self._analysis_timer.timeout.connect(self._analyze_async)

        self._pg.document().contentsChanged.connect(
            lambda: self._on_edit(self._pg))
        self._pd.document().contentsChanged.connect(
            lambda: self._on_edit(self._pd))

        # ── Chargement du texte ────────────────────────────────────────────────
        test_file = ASSETS_DIR / "texte-modele.txt"
        if test_file.exists():
            raw = test_file.read_text(encoding='utf-8')
            # Normaliser les sauts de ligne → espace simple (évite les coupures visuelles)
            self._full_text       = re.sub(r'\s+', ' ', raw).strip()
            self._full_word_count = len(_tokenize(self._full_text))
            self._words           = _tokenize(self._full_text[:VIVANT_SIZE])

    # ── Affichage initial ─────────────────────────────────────────────────────

    def showEvent(self, event):
        super().showEvent(event)
        QTimer.singleShot(0, self._fill_and_analyze)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if self._pg.toPlainText():
            QTimer.singleShot(0, self._fill_and_analyze)

    def _fill_and_analyze(self):
        """Remplir les pages PUIS analyser en synchrone → texte + badges ensemble."""
        self._fill_editors()
        self._apply_sync_analysis()

    def _fill_editors(self):
        vp_h = self._pg.viewport().height()
        vp_w = self._pg.viewport().width()
        if vp_h <= 10 or vp_w <= 10 or not self._words:
            return

        self._reflowing = True

        left_count  = self._find_split(self._pg, self._words, 0)
        right_count = self._find_split(self._pd, self._words, left_count)

        self._set_text(self._pg, "".join(self._words[:left_count]))
        self._set_text(self._pd,
                       "".join(self._words[left_count:left_count + right_count]))
        self._right_end = left_count + right_count

        self._reflowing = False
        self._update_footer()

    def _find_split(self, editor, words: list, start: int) -> int:
        available = words[start:]
        if not available:
            return 0
        lo, hi = 0, len(available)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            self._set_text(editor, "".join(available[:mid]))
            if editor.is_overflowing():
                hi = mid - 1
            else:
                lo = mid
        return lo

    def _set_text(self, editor, text: str):
        """
        setPlainText + re-set textWidth (clear() le remet à -1)
        + justification + interlignage 280 %.
        """
        editor.setPlainText(text)
        editor.document().setTextWidth(editor.viewport().width())
        if not text:
            return
        cursor = QTextCursor(editor.document())
        cursor.select(QTextCursor.SelectionType.Document)
        fmt = QTextBlockFormat()
        fmt.setAlignment(Qt.AlignmentFlag.AlignJustify)
        fmt.setLineHeight(config.LINE_HEIGHT_PCT, LINE_H_TYPE)
        cursor.setBlockFormat(fmt)

    # ── Analyse ───────────────────────────────────────────────────────────────

    def _vivant_text(self) -> str:
        left  = self._pg.toPlainText()
        right = self._pd.toPlainText()
        buf   = "".join(self._words[self._right_end:])
        return left + right + buf

    def _apply_sync_analysis(self):
        """Analyse synchrone — texte et badges apparaissent ensemble."""
        vivant = self._vivant_text()
        if not vivant.strip():
            return
        engine = ProxEngine(
            self._engine._nlp,
            self._engine.seuil_defaut,
            self._engine._profil,
        )
        engine.load_text(vivant)
        reps = engine.get_repetitions()
        self._analysis_id += 1
        self._distribute_badges(reps)

    def _analyze_async(self):
        """Analyse asynchrone pour les éditions (debounce 800 ms)."""
        vivant = self._vivant_text()
        if not vivant.strip():
            return
        self._analysis_id += 1
        aid    = self._analysis_id
        worker = AnalysisWorker(
            self._engine._nlp,
            self._engine.seuil_defaut,
            self._engine._profil,
            vivant, aid,
        )
        worker.finished.connect(self._on_async_done)
        worker.start()
        self._worker = worker

    def _on_async_done(self, reps: list, analysis_id: int):
        if analysis_id != self._analysis_id:
            return
        self._distribute_badges(reps)

    def _distribute_badges(self, reps: list):
        left_len    = len(self._pg.toPlainText())
        right_len   = len(self._pd.toPlainText())
        right_start = left_len

        left_events  = []
        right_events = []

        for i, rep in enumerate(reps):
            for offset, forme, direction in (
                (rep.offset_a, rep.forme_a, 'après'),
                (rep.offset_b, rep.forme_b, 'avant'),
            ):
                if offset < right_start:
                    left_events.append((offset, forme, rep.distance, direction, i))
                elif offset < right_start + right_len:
                    right_events.append(
                        (offset - right_start, forme, rep.distance, direction, i)
                    )

        self._pg.overlay.set_badges(left_events)
        self._pd.overlay.set_badges(right_events)

        n = len(reps)
        status = (f"{n} répétition{'s' if n > 1 else ''} dans ce passage"
                  if n else "Aucune répétition dans ce passage")
        self._lbl_info.setText(
            f"{status}   ·   Ctrl+←  page préc.   ·   Ctrl+→  page suiv."
        )

    # ── Navigation ────────────────────────────────────────────────────────────

    def _snap_to_word(self, pos: int) -> int:
        text, n = self._full_text, len(self._full_text)
        if pos <= 0:
            return 0
        if pos >= n:
            return n
        if pos > 0 and not text[pos - 1].isspace() and not text[pos].isspace():
            while pos < n and not text[pos].isspace():
                pos += 1
        while pos < n and text[pos].isspace():
            pos += 1
        return pos

    def next_page(self):
        new_start = self._snap_to_word(self._vivant_start + CHARS_PER_PAGE)
        if new_start >= len(self._full_text):
            return
        self._vivant_start = new_start
        self._words        = _tokenize(
            self._full_text[self._vivant_start:self._vivant_start + VIVANT_SIZE]
        )
        self._right_end = 0
        self._fill_and_analyze()

    def prev_page(self):
        if self._vivant_start == 0:
            return
        new_start          = self._snap_to_word(
            max(0, self._vivant_start - CHARS_PER_PAGE)
        )
        self._vivant_start = new_start
        self._words        = _tokenize(
            self._full_text[self._vivant_start:self._vivant_start + VIVANT_SIZE]
        )
        self._right_end = 0
        self._fill_and_analyze()

    # ── Transfert de curseur ──────────────────────────────────────────────────

    def transfer_to_right(self):
        self._pd.setFocus()
        cur = QTextCursor(self._pd.document())
        cur.movePosition(QTextCursor.MoveOperation.Start)
        self._pd.setTextCursor(cur)

    def transfer_to_left(self):
        self._pg.setFocus()
        cur = QTextCursor(self._pg.document())
        cur.movePosition(QTextCursor.MoveOperation.End)
        self._pg.setTextCursor(cur)

    # ── Édition ───────────────────────────────────────────────────────────────

    def _on_edit(self, editor):
        if self._reflowing:
            return
        self._pg.overlay.set_badges([])
        self._pd.overlay.set_badges([])
        self._reflow_timer.start()
        self._analysis_timer.start()

    def _do_reflow(self):
        self._reflowing = True
        MAX = len(self._words) + 10

        # PG déborde → PD
        i = 0
        while self._pg.is_overflowing() and i < MAX:
            word = self._pop_last_word(self._pg)
            if not word:
                break
            self._prepend_word(self._pd, word)
            i += 1

        # PD déborde → buffer
        i = 0
        while self._pd.is_overflowing() and i < MAX:
            if not self._pop_last_word(self._pd):
                break
            i += 1

        # PD → PG (underflow PG) : mot par mot, sans has_room()
        i = 0
        while self._pd.toPlainText() and i < MAX:
            word = self._peek_first_word(self._pd)
            if not word:
                break
            self._append_word(self._pg, word)
            if self._pg.is_overflowing():
                self._pop_last_word(self._pg)
                break
            self._pop_first_word(self._pd)
            i += 1

        # Buffer → PD (underflow PD)
        i = 0
        while self._right_end < len(self._words) and i < MAX:
            word = self._words[self._right_end]
            self._append_word(self._pd, word)
            if self._pd.is_overflowing():
                self._pop_last_word(self._pd)
                break
            self._right_end += 1
            i += 1

        self._reflowing = False

    # ── Manipulation de texte ─────────────────────────────────────────────────

    def _pop_last_word(self, editor) -> str:
        text     = editor.toPlainText()
        stripped = text.rstrip()
        if not stripped:
            return ""
        m = re.search(r'\S+\s*$', stripped)
        if not m:
            return ""
        split_pos = m.start()
        word      = text[split_pos:]
        cursor    = QTextCursor(editor.document())
        cursor.setPosition(split_pos)
        cursor.movePosition(QTextCursor.MoveOperation.End,
                            QTextCursor.MoveMode.KeepAnchor)
        cursor.removeSelectedText()
        return word

    def _pop_first_word(self, editor) -> str:
        text = editor.toPlainText()
        m    = re.match(r'\S+\s*', text)
        if not m:
            return ""
        word   = m.group(0)
        cursor = QTextCursor(editor.document())
        cursor.setPosition(0)
        cursor.setPosition(len(word), QTextCursor.MoveMode.KeepAnchor)
        cursor.removeSelectedText()
        return word

    def _peek_first_word(self, editor) -> str:
        m = re.match(r'\S+\s*', editor.toPlainText())
        return m.group(0) if m else ""

    def _prepend_word(self, editor, word: str):
        if word and not word[-1].isspace():
            word = word + ' '
        cursor = QTextCursor(editor.document())
        cursor.setPosition(0)
        cursor.insertText(word)

    def _append_word(self, editor, word: str):
        text = editor.toPlainText()
        if text and not text[-1].isspace() and not word[0:1].isspace():
            word = ' ' + word
        cursor = QTextCursor(editor.document())
        cursor.movePosition(QTextCursor.MoveOperation.End)
        cursor.insertText(word)

    # ── Footer ────────────────────────────────────────────────────────────────

    def _update_footer(self):
        total_chars  = len(self._full_text)
        total_pages  = max(1, (total_chars + CHARS_PER_PAGE - 1) // CHARS_PER_PAGE)
        current_page = self._vivant_start // CHARS_PER_PAGE + 1

        self._lbl_stats.setText(
            f"Page {current_page} / {total_pages}"
            f"   ·   {self._full_word_count} mots"
            f"   ·   {total_chars} caractères"
        )
        self._btn_prev.setEnabled(self._vivant_start > 0)
        self._btn_next.setEnabled(
            self._vivant_start + VIVANT_SIZE < total_chars
        )


# ══════════════════════════════════════════════════════════════════════════════
# Fenêtre
# ══════════════════════════════════════════════════════════════════════════════

class ProxWindow(QMainWindow):

    def __init__(self, engine: ProxEngine, filename: str = ""):
        super().__init__()
        self.setCentralWidget(ProxDoublePage(engine))
        self.setWindowTitle(f"Proximity — {filename}" if filename else "Proximity")
        self.setStyleSheet("QMainWindow { background: #c8c8c8; }")
        self.statusBar().hide()
        self.resize(1600, 960)


# ══════════════════════════════════════════════════════════════════════════════
# Splash
# ══════════════════════════════════════════════════════════════════════════════

def _make_splash() -> QSplashScreen:
    pix = QPixmap(520, 200)
    pix.fill(QColor(250, 250, 250))
    p = QPainter(pix)
    p.setFont(QFont("Georgia", 36, QFont.Weight.Bold))
    p.setPen(QColor(20, 20, 20))
    p.drawText(0, 0, 520, 120, Qt.AlignmentFlag.AlignCenter, "Proximity")
    p.setFont(QFont("Georgia", 13))
    p.setPen(QColor(120, 120, 120))
    p.drawText(0, 120, 520, 60, Qt.AlignmentFlag.AlignCenter,
               "Chargement du modèle linguistique…")
    p.end()
    return QSplashScreen(pix, Qt.WindowType.WindowStaysOnTopHint)


# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

def main():
    app = QApplication(sys.argv)
    app.setApplicationName("Proximity")

    splash = _make_splash()
    splash.show()
    app.processEvents()
    _t0 = time.monotonic()

    loader = LoadWorker()
    _keep  = [loader]

    test_file = ASSETS_DIR / "texte-modele.txt"
    filename  = test_file.name if test_file.exists() else ""

    def _show_main(nlp):
        engine = ProxEngine(nlp, seuil_defaut=config.SEUIL_DEFAUT)
        win    = ProxWindow(engine, filename=filename)
        _keep.append(win)
        win.show()
        splash.finish(win)

    def _on_loaded(nlp):
        if nlp is None:
            print("ERREUR : aucun modèle spaCy trouvé.")
            app.quit()
            return
        elapsed_ms = int((time.monotonic() - _t0) * 1000)
        remaining  = max(0, SPLASH_MIN_MS - elapsed_ms)
        QTimer.singleShot(remaining, lambda: _show_main(nlp))

    loader.done.connect(_on_loaded)
    loader.start()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()
