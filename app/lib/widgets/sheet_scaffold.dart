import 'package:flutter/material.dart';

import '../theme.dart';

/// Forest header and a warm paper working surface.
///
/// Every full screen uses it, so the overlap and the corner radius are defined
/// once. The sheet is positioned rather than translated — a translate would
/// leave its bottom 52px short of the screen and clip the last row of whatever
/// it holds.
class SheetScaffold extends StatefulWidget {
  const SheetScaffold({
    super.key,
    required this.hero,
    required this.heroHeight,
    required this.sheet,
    this.overlap = 16,
    this.sheetPadding = const EdgeInsets.fromLTRB(26, 34, 26, 26),
    this.floating = const [],
    this.fitHero = false,
    this.bottomBar,
    this.animateIn = false,
  });

  /// Entrance: sheet slides up, hero rises and fades in, then [EntranceItem]s
  /// in the sheet stagger in from the left.
  final bool animateIn;

  final Widget hero;
  final double heroHeight;
  final Widget sheet;

  final double overlap;
  final EdgeInsets sheetPadding;

  /// Drawn above the sheet — the walk-in button, the bottom nav.
  final List<Widget> floating;

  /// Let accessible enlarged-text headers and navigation take their natural height.
  final bool fitHero;
  final Widget? bottomBar;

  @override
  State<SheetScaffold> createState() => _SheetScaffoldState();
}

const _entranceMs = 1700.0;

Interval _span(double startMs, double lengthMs, Curve curve) => Interval(
    (startMs / _entranceMs).clamp(0.0, 1.0),
    ((startMs + lengthMs) / _entranceMs).clamp(0.0, 1.0),
    curve: curve);

class _SheetScaffoldState extends State<SheetScaffold> with SingleTickerProviderStateMixin {
  AnimationController? _controller;

  @override
  void initState() {
    super.initState();
    if (widget.animateIn) {
      _controller = AnimationController(vsync: this, duration: const Duration(milliseconds: 1700));
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final c = _controller;
    if (c != null && c.status == AnimationStatus.dismissed) {
      MediaQuery.disableAnimationsOf(context) ? c.value = 1 : c.forward();
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = _controller;
    Widget hero = widget.hero;
    Widget paper = Container(
      decoration: const BoxDecoration(
        color: Sc.paper,
        borderRadius: BorderRadius.only(topLeft: Sc.sheetRadius, topRight: Sc.sheetRadius)),
      clipBehavior: Clip.antiAlias,
      padding: widget.sheetPadding,
      child: widget.sheet,
    );
    if (c != null) {
      paper = SlideTransition(
        position: Tween(begin: const Offset(0, 1), end: Offset.zero)
            .animate(CurvedAnimation(parent: c, curve: _span(0, 700, const Cubic(0.32, 0.72, 0, 1)))),
        child: paper,
      );
      final heroIn = CurvedAnimation(parent: c, curve: _span(500, 500, Curves.easeOut));
      hero = AnimatedBuilder(
        animation: heroIn,
        child: hero,
        builder: (_, child) => Opacity(
          opacity: heroIn.value,
          child: Transform.translate(offset: Offset(0, 50 * (1 - heroIn.value)), child: child),
        ),
      );
    }
    return _Entrance(controller: c, child: Scaffold(backgroundColor: Sc.teal900, body: Stack(children: [
      if (widget.fitHero) Column(children: [
        ColoredBox(color: Sc.teal900, child: hero),
        Expanded(child: paper),
        ?widget.bottomBar,
      ]) else ...[
        Positioned(top: 0, left: 0, right: 0, height: widget.heroHeight,
          child: ColoredBox(color: Sc.teal900, child: hero)),
        Positioned(top: widget.heroHeight - widget.overlap, left: 0, right: 0, bottom: 0, child: paper),
      ],
      ...widget.floating,
    ])));
  }
}

class _Entrance extends InheritedWidget {
  const _Entrance({required this.controller, required super.child});
  final AnimationController? controller;
  @override
  bool updateShouldNotify(_Entrance old) => old.controller != controller;
}

/// Fades in and slides from 20px left, starting at 600ms + index × 100ms.
/// Renders [child] as-is outside an animating [SheetScaffold].
class EntranceItem extends StatelessWidget {
  const EntranceItem({super.key, required this.index, required this.child});
  final int index;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = context.dependOnInheritedWidgetOfExactType<_Entrance>()?.controller;
    if (c == null) return child;
    final t = CurvedAnimation(parent: c, curve: _span(600 + index * 100.0, 500, Curves.easeOut));
    return AnimatedBuilder(
      animation: t,
      child: child,
      builder: (_, child) => Opacity(
        opacity: t.value,
        child: Transform.translate(offset: Offset(-20 * (1 - t.value), 0), child: child),
      ),
    );
  }
}

/// The yellow disc with three leaning bars.
class LogoMark extends StatelessWidget {
  const LogoMark({super.key, this.size = 104});

  final double size;

  @override
  Widget build(BuildContext context) {
    final barHeight = size * 0.327;
    final barWidth = size * 0.067;

    return Container(
      width: size,
      height: size,
      decoration: const BoxDecoration(color: Sc.yellow, shape: BoxShape.circle),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: List.generate(3, (i) {
          return Padding(
            padding: EdgeInsets.symmetric(horizontal: size * 0.029),
            child: Transform(
              alignment: Alignment.center,
              transform: Matrix4.skewX(-0.21),
              child: Container(
                width: barWidth,
                height: barHeight,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
            ),
          );
        }),
      ),
    );
  }
}
