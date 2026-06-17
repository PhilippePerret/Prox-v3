"""
Prox — v1
"""

import sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QTextEdit, QSplashScreen, QWidget, QHBoxLayout,
)
from PySide6.QtCore import (
    QTimer, Qt, QEvent, QThread, Signal, QPoint, QRect, QSizeF, QRectF, QPointF,
)
from PySide6.QtGui import (
    QFont, QFontMetrics, QPainter, QColor, QPen, QPixmap,
    QTextCursor, QTextBlockFormat, QTextDocument, QCursor,
    QAbstractTextDocumentLayout, QTextOption,
)

from app.engine import ProxEngine
from app import config

BADGE_H_PAD  = 5
BADGE_V_PAD  = 2
SPLASH_MIN_MS = 1500
LINE_RATIO   = config.LINE_HEIGHT_PCT / 100.0   # 2.80


def _rep_color(distance: int) -> QColor:
    if distance < config.SEUIL_ROUGE:
        return QColor(180, 40, 40)
    elif distance < config.SEUIL_ORANGE:
        return QColor(190, 90, 15)
    return QColor(40, 120, 50)


# ══════════════════════════════════════════════════════════════════════════════
# Layout deux colonnes
# ══════════════════════════════════════════════════════════════════════════════

class ProxTwoColumnLayout(QAbstractTextDocumentLayout):
    """
    Layout mono-colonne classique MAIS documentSize() retourne toujours au
    moins 2×col_height, ce qui permet à la colonne droite de scroller jusqu'à
    col_height même quand le texte est court.

    Col gauche : scroll = 0          → affiche y ∈ [0, col_h)
    Col droite : scroll = col_height → affiche y ∈ [col_h, 2·col_h)
    """

    def __init__(self, document: QTextDocument):
        super().__init__(document)
        self._col_width  = 600.0
        self._col_height = 700.0
        # setViewportMargins gère déjà les marges visuelles — le layout
        # travaille dans l'espace VIEWPORT (pas besoin de marges supplémentaires)
        self._margin_v   = 12.0   # petit padding vertical en haut de chaque colonne
        # Pour hitTest : (top_y, advance, block_position, line_in_block)
        self._line_tops: list = []
        self._total_h   = 0.0

    # ── API externe ───────────────────────────────────────────────────────────

    def set_col_size(self, width: float, height: float):
        changed = (width != self._col_width or height != self._col_height)
        self._col_width  = max(100.0, width)
        self._col_height = max(100.0, height)
        if changed:
            self._do_layout()

    # ── QAbstractTextDocumentLayout overrides ─────────────────────────────────

    def documentChanged(self, from_pos: int, removed: int, added: int):
        self._do_layout()
        self.documentSizeChanged.emit(self.documentSize())

    def documentSize(self) -> QSizeF:
        padded = max(2.0 * self._col_height, self._total_h + self._col_height)
        return QSizeF(self._col_width, padded)

    def pageCount(self) -> int:
        return max(2, int(self._total_h / self._col_height) + 1)

    def frameBoundingRect(self, frame) -> QRectF:
        return QRectF(0, 0, self._col_width, self.documentSize().height())

    def blockBoundingRect(self, block) -> QRectF:
        tl = block.layout()
        if not tl or tl.lineCount() == 0:
            return QRectF()
        first = tl.lineAt(0)
        last  = tl.lineAt(tl.lineCount() - 1)
        return QRectF(
            0, first.y(),
            self._col_width,
            last.y() + last.height() - first.y(),
        )

    def draw(self, painter: QPainter, context):
        doc   = self.document()
        clip  = context.clip
        cpos  = context.cursorPosition  # position absolue dans le document

        block = doc.begin()
        while block.isValid():
            tl = block.layout()
            if tl and tl.lineCount() > 0:
                first = tl.lineAt(0)
                last  = tl.lineAt(tl.lineCount() - 1)
                block_top = first.y()
                block_bot = last.y() + last.height()
                if not clip.isNull() and block_bot < clip.top():
                    block = block.next()
                    continue
                if not clip.isNull() and block_top > clip.bottom():
                    break

                tl.draw(painter, QPointF(0, 0))

                # Curseur
                if cpos >= 0:
                    rel = cpos - block.position()
                    if 0 <= rel < block.length():
                        tl.drawCursor(painter, QPointF(0, 0), rel, 1)

            block = block.next()

    def hitTest(self, point: QPointF, accuracy) -> int:
        x, y = point.x(), point.y()
        doc   = self.document()

        for (top_y, advance, blk_pos, line_idx) in self._line_tops:
            if top_y <= y < top_y + advance:
                block = doc.findBlock(blk_pos)
                if block.isValid():
                    line = block.layout().lineAt(line_idx)
                    return block.position() + line.xToCursor(x)

        # Avant le premier bloc
        if self._line_tops and y < self._line_tops[0][0]:
            return 0

        # Après le dernier bloc
        return max(0, doc.characterCount() - 1)

    # ── Layout géométrique ────────────────────────────────────────────────────

    def _do_layout(self):
        doc = self.document()
        if self._col_width <= 0:
            return

        content_w = max(10.0, self._col_width)
        x  = 0.0
        y  = self._margin_v

        self._line_tops = []

        opt = QTextOption()
        opt.setWrapMode(QTextOption.WrapMode.WordWrap)

        block = doc.begin()
        while block.isValid():
            tl = block.layout()
            tl.setTextOption(opt)

            fmt = block.blockFormat()
            y  += fmt.topMargin()

            tl.beginLayout()
            line_idx = 0
            while True:
                line = tl.createLine()
                if not line.isValid():
                    break
                line.setLineWidth(content_w)
                nat_h   = line.height()
                advance = nat_h * LINE_RATIO
                line.setPosition(QPointF(x, y))
                self._line_tops.append((y, advance, block.position(), line_idx))
                y       += advance
                line_idx += 1
            tl.endLayout()

            y += fmt.bottomMargin()
            block = block.next()

        self._total_h = y + self._margin_v


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

    def __init__(self, editor: 'ProxColumnView'):
        super().__init__(editor.viewport())
        self._editor = editor
        self._word_annots: dict = {}
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground)
        self.setGeometry(editor.viewport().rect())
        self.raise_()
        editor.verticalScrollBar().valueChanged.connect(self.update)
        editor.cursorPositionChanged.connect(self.update)

    def set_badges(self, events: list):
        self._word_annots.clear()
        for offset, forme, distance, direction, rep_idx in events:
            color = _rep_color(distance)
            w = self._word_annots.setdefault(offset, {'forme': forme})
            w[direction] = (distance, rep_idx, color)
        self.update()

    def paintEvent(self, event):
        editor  = self._editor
        doc     = editor.document()
        fm      = QFontMetrics(editor.font())
        text_h  = fm.height()
        vp_h    = self.height()
        vp_w    = self.width()

        label_font = QFont(editor.font().family(), config.BADGE_FONT_PT)
        label_fm   = QFontMetrics(label_font)

        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        max_doc_pos = max(0, doc.characterCount() - 1)
        mouse_pos   = editor.viewport().mapFromGlobal(QCursor.pos())
        cursor_pos  = editor.textCursor().position()

        # ── Passe 1 : rects + répétitions actives ─────────────────────────────
        word_rects: dict = {}
        active_reps: set = set()

        for offset, info in self._word_annots.items():
            forme = info['forme']
            c1 = QTextCursor(doc)
            c1.setPosition(min(offset, max_doc_pos))
            r1 = editor.cursorRect(c1)
            c2 = QTextCursor(doc)
            c2.setPosition(min(offset + len(forme), max_doc_pos))
            r2 = editor.cursorRect(c2)
            word_rects[offset] = (r1, r2)

            badge_bot = r1.top() + text_h + 6 + label_fm.height() + BADGE_V_PAD * 2

            if offset <= cursor_pos < offset + len(forme):
                for key in ('avant', 'après'):
                    if key in info:
                        active_reps.add(info[key][1])

            if (r1.left() <= mouse_pos.x() <= max(r2.left(), r1.left() + 20)
                    and r1.top() <= mouse_pos.y() <= badge_bot):
                for key in ('avant', 'après'):
                    if key in info:
                        active_reps.add(info[key][1])

        # ── Filets ─────────────────────────────────────────────────────────────
        try:
            top_cur = editor.cursorForPosition(QPoint(0, 0))
        except Exception:
            return
        block = top_cur.block()
        if block.previous().isValid():
            block = block.previous()

        rule_pen = QPen(QColor(210, 210, 210), 1)
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
                        painter.drawLine(0, y_top + text_h + 4, vp_w, y_top + text_h + 4)
            block = block.next()

        # ── Badges : collecte → layout anti-chevauchement → dessin ─────────────
        if not self._word_annots:
            return

        bh = label_fm.height() + BADGE_V_PAD * 2
        badges = []

        for offset in sorted(self._word_annots.keys()):
            info  = self._word_annots[offset]
            rects = word_rects.get(offset)
            if rects is None:
                continue
            r1, r2  = rects
            y_top   = r1.top()
            if y_top + r1.height() < 0 or y_top > vp_h:
                continue
            badge_y = y_top + text_h + 6

            for key in ('avant', 'après'):
                if key not in info:
                    continue
                dist, rep_idx, color = info[key]
                label = f'←{dist}' if key == 'avant' else f'{dist}→'
                bw    = label_fm.horizontalAdvance(label) + BADGE_H_PAD * 2
                bx    = r1.left() if key == 'avant' else r2.left() - bw
                badges.append({
                    'y': badge_y, 'x': bx, 'w': bw, 'h': bh,
                    'label': label, 'color': color, 'rep_idx': rep_idx,
                })

        # Anti-chevauchement par ligne (même y = même ligne de texte)
        by_line: dict = {}
        for b in badges:
            by_line.setdefault(b['y'], []).append(b)

        for line_badges in by_line.values():
            line_badges.sort(key=lambda b: b['x'])
            for i in range(1, len(line_badges)):
                prev = line_badges[i - 1]
                curr = line_badges[i]
                if curr['x'] < prev['x'] + prev['w'] + 10:
                    curr['x'] = prev['x'] + prev['w'] + 10

        # Dessin
        painter.setFont(label_font)
        for b in badges:
            badge_rect = QRect(b['x'], b['y'], b['w'], b['h'])
            is_active  = b['rep_idx'] in active_reps
            box_alpha  = 210 if is_active else 64
            text_alpha = 255 if is_active else 180

            bg = QColor(b['color'])
            bg.setAlpha(box_alpha)
            painter.fillRect(badge_rect, bg)

            border = QColor(b['color'])
            border.setAlpha(box_alpha)
            painter.setPen(QPen(border, 1))
            painter.drawRect(badge_rect)

            painter.setPen(QColor(0, 0, 0, text_alpha))
            painter.drawText(badge_rect, Qt.AlignmentFlag.AlignCenter, b['label'])


# ══════════════════════════════════════════════════════════════════════════════
# Vue de colonne
# ══════════════════════════════════════════════════════════════════════════════

class ProxColumnView(QTextEdit):

    def __init__(self, is_right: bool, parent=None):
        super().__init__(parent)
        self._is_right   = is_right
        self._other:  'ProxColumnView | None' = None
        self._dp:     'ProxDoublePage | None'  = None

        self.setFont(QFont(config.FONT_FAMILY, config.FONT_SIZE_PT))
        self.setStyleSheet(
            "QTextEdit { background: white; border: none; color: #1a1a1a; }"
        )
        self.setViewportMargins(config.MARGIN_PX, 48, config.MARGIN_PX, 48)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        if not is_right:
            self.setPlaceholderText("Collez votre texte ici…")

        self.overlay = ProxAnnotationOverlay(self)
        self.viewport().setMouseTracking(True)
        self.viewport().installEventFilter(self)
        self.cursorPositionChanged.connect(self._check_bounds)

    def set_other(self, other: 'ProxColumnView'):
        self._other = other

    def set_dp(self, dp: 'ProxDoublePage'):
        self._dp = dp

    # ── Événements ────────────────────────────────────────────────────────────

    def eventFilter(self, obj, event):
        if obj is self.viewport():
            t = event.type()
            if t == QEvent.Type.Resize:
                self.overlay.setGeometry(self.viewport().rect())
                self._notify_layout_size()
                if self._is_right:
                    QTimer.singleShot(0, self._lock_right)
            elif t in (QEvent.Type.MouseMove, QEvent.Type.Leave):
                self.overlay.update()
        return super().eventFilter(obj, event)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._notify_layout_size()
        if self._is_right:
            QTimer.singleShot(0, self._lock_right)

    def scrollContentsBy(self, dx, dy):
        if self._is_right:
            super().scrollContentsBy(dx, dy)
        # colonne gauche : bloquée à 0 (wheel + ensureCursorVisible désactivés)
        self.overlay.update()

    def ensureCursorVisible(self):
        pass

    def wheelEvent(self, event):
        pass

    def keyPressEvent(self, event):
        key = event.key()
        mod = event.modifiers()
        CTRL = Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier
        if key in (Qt.Key.Key_Down, Qt.Key.Key_Up) and bool(mod & CTRL):
            if self._dp:
                self._dp.navigate_rep(forward=(key == Qt.Key.Key_Down))
            return
        super().keyPressEvent(event)

    # ── Verrou droite ──────────────────────────────────────────────────────────

    def _notify_layout_size(self):
        """Informe le layout custom de la taille de la colonne."""
        doc = self.document()
        if doc is None:
            return
        lyt = doc.documentLayout()
        if isinstance(lyt, ProxTwoColumnLayout):
            vp = self.viewport()
            lyt.set_col_size(float(vp.width()), float(vp.height()))

    def _lock_right(self):
        if not self._is_right:
            return
        try:
            target = self.viewport().height()
        except RuntimeError:
            return
        if target <= 0:
            return
        bar = self.verticalScrollBar()
        if bar.maximum() < target:
            bar.setMaximum(target)
        bar.setValue(target)

    # ── Flux curseur inter-colonnes ────────────────────────────────────────────

    def _check_bounds(self):
        if not self._other or not self.hasFocus():
            return
        cur  = self.textCursor()
        rect = self.cursorRect(cur)
        vp_h = self.viewport().height()
        pos  = cur.position()
        anch = cur.anchor()

        if not self._is_right and rect.top() >= vp_h:
            self._transfer_to(self._other, pos, anch)
        elif self._is_right and rect.bottom() <= 0:
            self._transfer_to(self._other, pos, anch)

    def _transfer_to(self, target: 'ProxColumnView', pos: int, anchor: int):
        target.setFocus()
        cur = QTextCursor(self.document())
        cur.setPosition(anchor)
        if anchor != pos:
            cur.setPosition(pos, QTextCursor.MoveMode.KeepAnchor)
        target.setTextCursor(cur)


# ══════════════════════════════════════════════════════════════════════════════
# Double page
# ══════════════════════════════════════════════════════════════════════════════

class ProxDoublePage(QWidget):

    def __init__(self, engine: ProxEngine, parent=None):
        super().__init__(parent)
        self._engine       = engine
        self._analysis_id  = 0
        self._worker       = None
        self._applying_fmt = False
        self._rep_data: list = []

        # Document partagé avec layout custom
        self._doc = QTextDocument(self)
        self._doc.setDefaultFont(QFont(config.FONT_FAMILY, config.FONT_SIZE_PT))
        self._layout = ProxTwoColumnLayout(self._doc)
        self._doc.setDocumentLayout(self._layout)

        self._left  = ProxColumnView(is_right=False, parent=self)
        self._right = ProxColumnView(is_right=True,  parent=self)
        for col in (self._left, self._right):
            col.setDocument(self._doc)
            col.set_other(self._right if col is self._left else self._left)
            col.set_dp(self)

        # Re-lock droite après changement de taille du document
        self._layout.documentSizeChanged.connect(
            lambda _: QTimer.singleShot(0, self._right._lock_right)
        )

        lay = QHBoxLayout(self)
        lay.setContentsMargins(24, 24, 24, 24)
        lay.setSpacing(config.PAGE_GUTTER)
        lay.addWidget(self._left)
        lay.addWidget(self._right)

        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self._analyze)

        self._doc.contentsChanged.connect(self._on_doc_changed)

    # ── Navigation ────────────────────────────────────────────────────────────

    def navigate_rep(self, forward: bool):
        focused = (self._right
                   if self._right.hasFocus() else self._left)
        pos = focused.textCursor().position()
        if forward:
            for off, forme in self._rep_data:
                if off > pos:
                    self._go_to(off, forme)
                    return
        else:
            for off, forme in reversed(self._rep_data):
                if off < pos:
                    self._go_to(off, forme)
                    return

    def _go_to(self, off: int, forme: str):
        focused = (self._right
                   if self._right.hasFocus() else self._left)
        cur = QTextCursor(self._doc)
        cur.setPosition(off)
        cur.setPosition(off + len(forme), QTextCursor.MoveMode.KeepAnchor)
        focused.setTextCursor(cur)

    # ── Doc changes ───────────────────────────────────────────────────────────

    def _on_doc_changed(self):
        self._timer.start(config.DEBOUNCE_MS)

    def _analyze(self):
        text = self._doc.toPlainText()
        if not text.strip():
            return
        self._analysis_id += 1
        aid    = self._analysis_id
        worker = AnalysisWorker(
            self._engine._nlp,
            self._engine.seuil_defaut,
            self._engine._profil,
            text, aid,
        )
        worker.finished.connect(self._on_done)
        worker.start()
        self._worker = worker
        self._set_status("Analyse en cours…")

    def _on_done(self, reps: list, analysis_id: int):
        if analysis_id != self._analysis_id:
            return

        events      = []
        rep_offsets = []
        for i, rep in enumerate(reps):
            events.append((rep.offset_a, rep.forme_a, rep.distance, 'après', i))
            events.append((rep.offset_b, rep.forme_b, rep.distance, 'avant', i))
            rep_offsets.append((rep.offset_a, rep.forme_a))
            rep_offsets.append((rep.offset_b, rep.forme_b))

        self._rep_data = sorted(rep_offsets)
        self._left.overlay.set_badges(events)
        self._right.overlay.set_badges(events)

        n = len(reps)
        self._set_status(
            f"{n} répétition{'s' if n > 1 else ''}" if n else "Aucune répétition"
        )

    def _set_status(self, msg: str):
        win = self.window()
        if hasattr(win, 'statusBar'):
            win.statusBar().showMessage(msg)


# ══════════════════════════════════════════════════════════════════════════════
# Fenêtre
# ══════════════════════════════════════════════════════════════════════════════

class ProxWindow(QMainWindow):

    def __init__(self, engine: ProxEngine):
        super().__init__()
        self.setCentralWidget(ProxDoublePage(engine))
        self.setWindowTitle("Prox")
        self.resize(1200, 900)
        self.setStyleSheet("QMainWindow { background: #c8c8c8; }")
        self.statusBar().showMessage("Prêt.")


# ══════════════════════════════════════════════════════════════════════════════
# Splash
# ══════════════════════════════════════════════════════════════════════════════

def _make_splash() -> QSplashScreen:
    pix = QPixmap(480, 180)
    pix.fill(QColor(255, 255, 255))
    p = QPainter(pix)
    p.setFont(QFont("Georgia", 28))
    p.setPen(QColor(30, 30, 30))
    p.drawText(0, 0, 480, 100, Qt.AlignmentFlag.AlignCenter, "Prox")
    p.setFont(QFont("Georgia", 11))
    p.setPen(QColor(130, 130, 130))
    p.drawText(0, 100, 480, 60, Qt.AlignmentFlag.AlignCenter,
               "Chargement du modèle linguistique…")
    p.end()
    return QSplashScreen(pix, Qt.WindowType.WindowStaysOnTopHint)


# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

def main():
    app = QApplication(sys.argv)
    app.setApplicationName("Prox")

    splash = _make_splash()
    splash.show()
    app.processEvents()
    _t0 = time.monotonic()

    loader = LoadWorker()
    _keep  = [loader]

    def _show_main(nlp):
        engine = ProxEngine(nlp, seuil_defaut=config.SEUIL_DEFAUT)
        win    = ProxWindow(engine)
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
