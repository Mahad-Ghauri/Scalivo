import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/models.dart';
import '../../format.dart';
import '../../state/calendar_controller.dart';
import '../../theme.dart';
import '../../widgets/appointment_card.dart';
import '../block_time_sheet.dart';
import '../booking_sheet.dart';
import '../../state/auth_controller.dart';

/// The diary, one day at a time.
///
/// The week uses an agenda to keep appointments readable on a phone, with a
/// staff filter shared by both views.
class CalendarTab extends StatefulWidget {
  const CalendarTab({super.key});

  @override
  State<CalendarTab> createState() => _CalendarTabState();
}

class _CalendarTabState extends State<CalendarTab> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final controller = context.read<CalendarController>();
      controller.ensureCatalogue();
      if (controller.view == null) controller.load();
    });
  }

  Future<void> _blockTime(CalendarController controller) async {
    await showBlockTimeSheet(context, controller: controller);
  }

  @override
  Widget build(BuildContext context) {
    final controller = context.watch<CalendarController>();

    final header = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _DateStrip(
          selected: controller.selectedDay,
          onPick: controller.goTo,
          onBlock: () => _blockTime(controller),
        ),
        if (controller.staffList.length > 1) ...[
          const SizedBox(height: 14),
          _StaffFilter(
            staff: controller.staffList,
            selected: controller.staffFilter,
            onPick: controller.setStaffFilter,
          ),
        ],
        Wrap(spacing: 12, children: [
          FilterChip(label: const Text('Show cancelled'), selected: controller.includeCancelled, onSelected: controller.loading ? null : controller.showCancelled),
          if (controller.rangeDays == 1) ActionChip(label: const Text('Week agenda'), onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => _WeekAgenda(date: controller.selectedDay, staffId: controller.staffFilter)))),
        ]),
        const SizedBox(height: 16),
      ],
    );
    return DayAgenda(controller: controller, header: header);
  }
}

/// Seven days at a time, anchored on the selected one, plus a jump to any date.
///
/// Anchored rather than fixed to the current week: an owner looking at next
/// Tuesday wants the days either side of it, not the days either side of today.
class _DateStrip extends StatelessWidget {
  const _DateStrip({
    required this.selected,
    required this.onPick,
    required this.onBlock,
  });

  final DateTime selected;
  final ValueChanged<DateTime> onPick;
  final VoidCallback onBlock;

  @override
  Widget build(BuildContext context) {
    final start = selected.subtract(const Duration(days: 3));
    final largeText = MediaQuery.textScalerOf(context).scale(24) > 36;
    final heading = Text(
      dayLabelLong(selected),
      style: const TextStyle(
        fontSize: 24,
        fontWeight: FontWeight.w500,
        color: Sc.ink,
        letterSpacing: -0.2,
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (largeText) heading,
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            if (!largeText) Expanded(child: heading),
            if (!isSameDay(selected, startOfToday()))
              TextButton(
                onPressed: () => onPick(startOfToday()),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  minimumSize: const Size(48, 48),
                ),
                child: const Text(
                  'TODAY',
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.7,
                    color: Sc.teal,
                  ),
                ),
              ),
            IconButton(
              onPressed: () => _jump(context),
              tooltip: 'Choose date',
              icon: const Icon(Icons.calendar_month_rounded, size: 19, color: Sc.slate),
            ),
            // Blocking lives in a menu rather than on the floating button: that
            // button is for adding a customer, and the two are opposite actions
            // that would be one mis-tap apart.
            PopupMenuButton<String>(
              tooltip: 'More',
              color: Colors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
              onSelected: (value) {
                if (value == 'block') onBlock();
              },
              icon: const Icon(Icons.more_horiz_rounded, size: 19, color: Sc.slate),
              itemBuilder: (_) => const [
                PopupMenuItem(
                  value: 'block',
                  child: Text(
                    'Block time off',
                    style: TextStyle(fontSize: 13.5, color: Sc.ink),
                  ),
                ),
              ],
            ),
          ],
        ),
        const SizedBox(height: 12),
        SizedBox(
          height: (MediaQuery.textScalerOf(context).scale(25.5) * 1.5 + 14)
              .clamp(78.0, double.infinity).toDouble(),
          child: ListView(
            scrollDirection: Axis.horizontal,
            children: [
              for (var i = 0; i < 7; i++)
                SizedBox(width: MediaQuery.textScalerOf(context).scale(14) > 20 ? 64 : 48,
                  child: _pill(start.add(Duration(days: i)))),
            ],
          ),
        ),
      ],
    );
  }

  Widget _pill(DateTime date) {
    final isSelected = isSameDay(date, selected);
    final isToday = isSameDay(date, startOfToday());

    return Semantics(button: true, selected: isSelected, label: dayLabelLong(date),
      child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2.5),
      child: Material(
        color: isSelected ? Sc.teal900 : Colors.transparent,
        borderRadius: BorderRadius.circular(4),
        child: InkWell(
          onTap: () => onPick(date),
          borderRadius: BorderRadius.circular(4),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                ['M', 'T', 'W', 'T', 'F', 'S', 'S'][date.weekday - 1],
                style: TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w500,
                  color: isSelected ? Sc.onTealMuted : Sc.slateLight,
                ),
              ),
              const SizedBox(height: 5),
              Text(
                '${date.day}',
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  color: isSelected ? Colors.white : Sc.ink,
                ),
              ),
              const SizedBox(height: 4),
              // Today keeps a marker even when another day is selected —
              // otherwise the owner loses their place in the strip.
              Container(
                width: 4,
                height: 4,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: isToday
                      ? (isSelected ? Sc.yellow : Sc.teal)
                      : Colors.transparent,
                ),
              ),
            ],
          ),
        ),
      ),
      ),
    );
  }

  Future<void> _jump(BuildContext context) async {
    final picked = await showDatePicker(
      context: context,
      initialDate: selected,
      firstDate: startOfToday().subtract(const Duration(days: 365)),
      lastDate: startOfToday().add(const Duration(days: 365)),
    );
    if (picked != null) onPick(picked);
  }
}

class _StaffFilter extends StatelessWidget {
  const _StaffFilter({required this.staff, required this.selected, required this.onPick});

  final List<StaffSummary> staff;
  final String? selected;
  final ValueChanged<String?> onPick;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 48,
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: [
          _chip('Everyone', selected == null, () => onPick(null)),
          for (final member in staff)
            _chip(member.name, selected == member.id, () => onPick(member.id)),
        ],
      ),
    );
  }

  Widget _chip(String label, bool active, VoidCallback onTap) {
    return Semantics(button: true, selected: active, child: Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Material(
        color: active ? Sc.tealSoft : Sc.chipFill,
        borderRadius: BorderRadius.circular(9),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(9),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Center(
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                  color: active ? Sc.teal900 : Sc.inkMuted,
                ),
              ),
            ),
          ),
        ),
      ),
    ));
  }
}

/// The appointments and blocks for whichever day is selected.
///
/// Shared with the Today tab: they are the same list asked about different days,
/// and two implementations would drift the moment one grew a status the other
/// did not draw.
class DayAgenda extends StatelessWidget {
  const DayAgenda({super.key, required this.controller, this.emptyState, this.header});

  final CalendarController controller;

  /// Today has a richer empty state — it is the screen an owner opens on day one.
  final Widget? emptyState;
  final Widget? header;

  @override
  Widget build(BuildContext context) {
    final entries = controller.entries;
    final blocks = controller.blocks;
    final staffNames = {for (final s in controller.staffList) s.id: s.name};
    Widget? state;
    if (controller.loading && controller.view == null) {
      state = const Padding(padding: EdgeInsets.symmetric(vertical: 60),
        child: Center(child: CircularProgressIndicator(color: Sc.teal)));
    } else if (controller.error != null && controller.view == null) {
      state = _Failed(message: controller.error!.message, onRetry: () => controller.load());
    } else if (entries.isEmpty && blocks.isEmpty) {
      state = Padding(padding: const EdgeInsets.symmetric(vertical: 40),
        child: emptyState ?? const _NothingOn());
    }
    return RefreshIndicator(
      color: Sc.teal,
      onRefresh: () => controller.load(quiet: true),
      child: CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          if (header != null) SliverToBoxAdapter(child: header),
          if (state != null) SliverToBoxAdapter(child: state)
          else SliverList(delegate: SliverChildBuilderDelegate((context, index) {
            if (index >= entries.length) {
              final block = blocks[index - entries.length];
              return Padding(padding: const EdgeInsets.only(top: 12), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                if (controller.rangeDays > 1) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(dayLabelLong(block.startsAt), style: const TextStyle(fontWeight: FontWeight.w600))),
                BlockCard(
                block: block,
                staffName: block.staffId == null ? null : staffNames[block.staffId],
                onRemove: () => _removeBlock(context, controller, block)),
              ]));
            }
            final entry = entries[index];
            return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              if (controller.rangeDays > 1 && (index == 0 || !isSameDay(entries[index - 1].startsAt, entry.startsAt))) Padding(padding: const EdgeInsets.only(top: 16, bottom: 8), child: Text(dayLabelLong(entry.startsAt), style: const TextStyle(fontWeight: FontWeight.w600))),
              AppointmentCard(entry: entry, onTap: () => showBookingSheet(context, controller: controller, entry: entry)),
            ]);
          }, childCount: entries.length + blocks.length)),
          const SliverToBoxAdapter(child: SizedBox(height: 90)),
        ],
      ),
    );
  }

}

/// Lifting a block.
///
/// Confirmed, because the opposite of blocking is offering: removing one puts
/// that time back in front of customers immediately, and an accidental tap on a
/// Friday marked off for a funeral is not a small mistake.
Future<void> _removeBlock(
  BuildContext context,
  CalendarController controller,
  CalendarBlock block,
) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      backgroundColor: Colors.white,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      title: const Text(
        'Unblock this time?',
        style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: Sc.ink),
      ),
      content: const Text(
        'Customers will be offered these slots again straight away.',
        style: TextStyle(fontSize: 13.5, color: Sc.inkMuted, height: 1.5),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: const Text('KEEP BLOCKED', style: TextStyle(color: Sc.slate, fontSize: 12.5)),
        ),
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(true),
          child: const Text(
            'UNBLOCK',
            style: TextStyle(color: Sc.teal, fontSize: 12.5, fontWeight: FontWeight.w600),
          ),
        ),
      ],
    ),
  );
  if (ok != true) return;

  final failure = await controller.removeBlock(block);
  if (failure == null || !context.mounted) return;

  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      behavior: SnackBarBehavior.floating,
      backgroundColor: Sc.dangerTitle,
      content: Text(failure.message),
    ),
  );
}

class _NothingOn extends StatelessWidget {
  const _NothingOn();

  @override
  Widget build(BuildContext context) {
    return const Column(
      children: [
        Icon(Icons.event_available_outlined, size: 34, color: Sc.slateFaint),
        SizedBox(height: 14),
        Text(
          'Nothing booked',
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Sc.inkMuted),
        ),
        SizedBox(height: 6),
        Text(
          'A free day, or one nobody has found yet.',
          style: TextStyle(fontSize: 13, color: Sc.slate),
        ),
      ],
    );
  }
}

class _Failed extends StatelessWidget {
  const _Failed({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.cloud_off_rounded, size: 32, color: Sc.slateFaint),
          const SizedBox(height: 14),
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13.5, color: Sc.slate, height: 1.5),
          ),
          const SizedBox(height: 16),
          TextButton(
            onPressed: onRetry,
            child: const Text(
              'TRY AGAIN',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.8,
                color: Sc.teal,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _WeekAgenda extends StatelessWidget {
  const _WeekAgenda({required this.date, this.staffId});
  final DateTime date;
  final String? staffId;
  @override
  Widget build(BuildContext context) {
    final auth = context.read<AuthController>();
    return ChangeNotifierProvider(create: (_) => CalendarController(api: auth.api, businessId: auth.business!.id, rangeDays: 7)..selectedDay = date
        ..staffFilter = staffId,
      child: Scaffold(backgroundColor: Sc.paper, appBar: AppBar(title: const Text('Seven-day agenda')), body: const Padding(padding: EdgeInsets.all(22), child: CalendarTab())));
  }
}
