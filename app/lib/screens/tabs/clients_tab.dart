import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/models.dart';
import '../../format.dart';
import '../../state/clients_controller.dart';
import '../../theme.dart';
import '../../widgets/client_tag.dart';
import '../client_profile_screen.dart';

/// Everyone who has ever booked, and nothing anyone typed.
///
/// The whole list is a by-product: profiles are created and enriched by booking
/// events, so an owner who has never opened this screen still has a complete
/// customer database the day they do. That is the claim the screen has to make
/// legible, which is why the empty state explains where the rows come from
/// rather than offering an "Add customer" button that would undermine it.
class ClientsTab extends StatefulWidget {
  const ClientsTab({super.key});

  @override
  State<ClientsTab> createState() => _ClientsTabState();
}

class _ClientsTabState extends State<ClientsTab> {
  final _search = TextEditingController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final controller = context.read<ClientsController>();
      if (controller.clients.isEmpty && controller.error == null) controller.load();
    });
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = context.watch<ClientsController>();

    final header = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            const Expanded(
              child: Text(
                'Clients',
                style: TextStyle(
                  fontSize: 34,
                  fontWeight: FontWeight.w500,
                  color: Sc.ink,
                  letterSpacing: -0.2,
                ),
              ),
            ),
            if (controller.total > 0)
              Text(
                '${controller.total}',
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  color: Sc.slate,
                ),
              ),
          ],
        ),
        const SizedBox(height: 14),
        _searchField(controller),
        const SizedBox(height: 12),
        _tagFilter(controller),
        const SizedBox(height: 14),
      ],
    );
    return _list(controller, header);
  }

  Widget _searchField(ClientsController controller) {
    return Container(
      decoration: BoxDecoration(
        color: Sc.chipFill,
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: Sc.divider),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 13),
      child: Row(
        children: [
          const Icon(Icons.search_rounded, size: 18, color: Sc.slateLight),
          const SizedBox(width: 9),
          Expanded(
            child: TextField(
              controller: _search,
              onChanged: controller.search,
              style: const TextStyle(fontSize: 14.5, color: Sc.ink),
              decoration: const InputDecoration(
                isDense: true,
                border: InputBorder.none,
                contentPadding: EdgeInsets.symmetric(vertical: 13),
                // Searching by number matters as much as by name: an owner with
                // a missed call knows the number, not who it was.
                labelText: 'Search clients',
                floatingLabelBehavior: FloatingLabelBehavior.never,
                hintText: 'Name or number',
                hintStyle: TextStyle(fontSize: 14.5, color: Sc.slateFaint),
              ),
            ),
          ),
          if (controller.query.isNotEmpty)
            IconButton(tooltip: 'Clear search', onPressed: () {
              _search.clear(); controller.search('');
            }, icon: const Icon(Icons.close_rounded, size: 20, color: Sc.slate)),
        ],
      ),
    );
  }

  Widget _tagFilter(ClientsController controller) {
    const tags = ['new', 'vip', 'at_risk', 'lapsed'];

    return SizedBox(
      height: 48,
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: [
          for (final tag in tags)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: _FilterChip(
                tag: tag,
                active: controller.tag == tag,
                onTap: () => controller.filterByTag(tag),
              ),
            ),
        ],
      ),
    );
  }

  Widget _list(ClientsController controller, Widget header) {
    Widget? state;
    if (controller.loading && controller.clients.isEmpty) {
      state = const Padding(padding: EdgeInsets.symmetric(vertical: 60),
        child: Center(child: CircularProgressIndicator(color: Sc.teal)));
    } else if (controller.error != null && controller.clients.isEmpty) {
      state = _message(icon: Icons.cloud_off_rounded, title: controller.error!.message,
        body: 'Pull down to try again.');
    } else if (controller.clients.isEmpty) {
      final filtered = controller.query.isNotEmpty || controller.tag != null;
      state = _message(icon: filtered ? Icons.search_off_rounded : Icons.people_outline_rounded,
        title: filtered ? 'Nobody matches' : 'No clients yet',
        body: filtered ? 'Try a different name, number or tag.'
          : 'Profiles build themselves. The first time somebody books — over '
            'WhatsApp or at the desk — they appear here with their history, '
            'and nobody types anything.');
    }
    return RefreshIndicator(color: Sc.teal, onRefresh: controller.load,
      child: CustomScrollView(physics: const AlwaysScrollableScrollPhysics(), slivers: [
        SliverToBoxAdapter(child: header),
        if (state != null) SliverToBoxAdapter(child: state)
        else SliverList(delegate: SliverChildBuilderDelegate((context, index) {
          if (index < controller.clients.length) {
            return DecoratedBox(decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: Sc.divider))),
              child: _ClientRowTile(row: controller.clients[index]));
          }
          if (controller.hasMore) {
            return TextButton(onPressed: controller.loading ? null : controller.loadMore,
              child: Text(controller.loading ? 'Loading…' : 'Load more clients'));
          }
          return controller.clients.length < controller.total
            ? const Padding(padding: EdgeInsets.all(16),
              child: Text('Search or choose a tag to narrow the results.'))
            : const SizedBox.shrink();
        }, childCount: controller.clients.length + 1)),
        const SliverToBoxAdapter(child: SizedBox(height: 90)),
      ]),
    );
  }

  Widget _message({required IconData icon, required String title, required String body}) {
    return Padding(padding: const EdgeInsets.symmetric(vertical: 40),
      child: Column(children: [
        Icon(icon, size: 34, color: Sc.slate), const SizedBox(height: 14),
        Text(title, textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Sc.inkMuted)),
        const SizedBox(height: 7),
        Padding(padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Text(body, textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13, color: Sc.slate, height: 1.55))),
      ]),
    );
  }

}

class _FilterChip extends StatelessWidget {
  const _FilterChip({required this.tag, required this.active, required this.onTap});

  final String tag;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final style = tagStyle(tag);

    return Semantics(button: true, selected: active, child: Material(
      color: active ? style.fill : Sc.chipFill,
      borderRadius: BorderRadius.circular(9),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(9),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(9),
            border: Border.all(color: active ? style.text.withValues(alpha: 0.3) : Sc.chipFill),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 13),
          child: Center(
            child: Text(
              style.label,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                color: active ? style.text : Sc.inkMuted,
              ),
            ),
          ),
        ),
      ),
    ));
  }
}

class _ClientRowTile extends StatelessWidget {
  const _ClientRowTile({required this.row});

  final ClientRow row;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ClientProfileScreen(
            clientId: row.clientId,
            fallbackName: row.displayName,
          ),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 13),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: const BoxDecoration(color: Sc.tealSoft, shape: BoxShape.circle),
              alignment: Alignment.center,
              child: Text(
                _initial(row.displayName),
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: Sc.teal900,
                ),
              ),
            ),
            const SizedBox(width: 13),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(row.displayName ?? row.phone ?? 'Unnamed',
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: Sc.ink)),
                  if (row.tags.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6),
                    child: Wrap(spacing: 6, runSpacing: 4,
                      children: [for (final tag in row.tags.take(2)) ClientTagChip(tag: tag, dense: true)])),
                  const SizedBox(height: 3),
                  Text(
                    '${row.totalVisits} ${row.totalVisits == 1 ? 'visit' : 'visits'}'
                    ' · last ${agoLabel(row.lastVisitAt)}',
                    style: const TextStyle(fontSize: 12.5, color: Sc.slate),
                  ),
                  const SizedBox(height: 4),
                  Text(money(row.lifetimeSpendMinor), style: const TextStyle(fontSize: 12.5,
                    fontWeight: FontWeight.w500, color: Sc.inkMuted)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  static String _initial(String? name) {
    final trimmed = name?.trim() ?? '';
    return trimmed.isEmpty ? '?' : trimmed.characters.first.toUpperCase();
  }
}
