import 'package:flutter/material.dart';

import '../theme.dart';

/// The app's signature shape: a teal hero with a white sheet riding up over it.
///
/// Every full screen uses it, so the overlap and the corner radius are defined
/// once. The sheet is positioned rather than translated — a translate would
/// leave its bottom 52px short of the screen and clip the last row of whatever
/// it holds.
class SheetScaffold extends StatelessWidget {
  const SheetScaffold({
    super.key,
    required this.hero,
    required this.heroHeight,
    required this.sheet,
    this.overlap = 52,
    this.sheetPadding = const EdgeInsets.fromLTRB(26, 34, 26, 26),
    this.floating = const [],
  });

  final Widget hero;
  final double heroHeight;
  final Widget sheet;

  final double overlap;
  final EdgeInsets sheetPadding;

  /// Drawn above the sheet — the walk-in button, the bottom nav.
  final List<Widget> floating;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Sc.teal900,
      body: Stack(
        children: [
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: heroHeight,
            child: ColoredBox(color: Sc.teal900, child: hero),
          ),
          Positioned(
            top: heroHeight - overlap,
            left: 0,
            right: 0,
            bottom: 0,
            child: Container(
              decoration: const BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.only(
                  topLeft: Sc.sheetRadius,
                  topRight: Sc.sheetRadius,
                ),
              ),
              clipBehavior: Clip.antiAlias,
              padding: sheetPadding,
              child: sheet,
            ),
          ),
          ...floating,
        ],
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
