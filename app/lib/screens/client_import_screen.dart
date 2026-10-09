import 'dart:convert';
import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/growth_models.dart';
import '../import/client_csv.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/owner_report_widgets.dart';
import '../widgets/sc_button.dart';

class ClientImportScreen extends StatefulWidget {
  const ClientImportScreen({super.key});
  @override
  State<ClientImportScreen> createState() => _ClientImportScreenState();
}

enum _ImportAction { pick, preview, confirm, apply }

class _ClientImportScreenState extends State<ClientImportScreen> {
  List<List<String>>? _table;
  Map<String, int?> _columns = {};
  List<Map<String, String>>? _previewRows;
  ClientImportResult? _result;
  ApiException? _error;
  bool _uncertain = false;
  _ImportAction? _action;
  bool get _busy => _action != null;

  Future<void> _pick() async {
    if (_busy) return;
    setState(() {
      _action = _ImportAction.pick;
      _error = null;
    });
    try {
      final file = await openFile(
        acceptedTypeGroups: [
          const XTypeGroup(
            label: 'CSV spreadsheet',
            extensions: ['csv'],
            mimeTypes: ['text/csv', 'text/comma-separated-values'],
            uniformTypeIdentifiers: ['public.comma-separated-values-text'],
          ),
        ],
      );
      if (file == null) {
        if (mounted) setState(() => _action = null);
        return;
      }
      if (!file.name.toLowerCase().endsWith('.csv') ||
          await file.length().timeout(const Duration(seconds: 10)) >
              maxClientCsvBytes) {
        throw const FormatException('Choose a CSV file of up to 1 MB');
      }
      // Bound the stream too: a selected file can change after its size check.
      final bytes = BytesBuilder(copy: false);
      await for (final chunk in file.openRead().timeout(
        const Duration(seconds: 10),
      )) {
        if (bytes.length + chunk.length > maxClientCsvBytes) {
          throw const FormatException('File exceeds 1 MB');
        }
        bytes.add(chunk);
      }
      final table = await compute(parseClientCsv, bytes.takeBytes());
      if (!mounted) return;
      setState(() {
        _table = table;
        _previewRows = null;
        _result = null;
        _uncertain = false;
        _columns = {
          for (final field in clientImportFields)
            field:
                table.first.any(
                  (name) => name.toLowerCase() == field.toLowerCase(),
                )
                ? table.first.indexWhere(
                    (name) => name.toLowerCase() == field.toLowerCase(),
                  )
                : null,
        };
        _action = null;
      });
    } on FormatException catch (err) {
      if (mounted) {
        setState(() {
          _error = ApiException(ApiErrorKind.validation, err.message);
          _action = null;
        });
      }
    } on Object {
      if (mounted) {
        setState(() {
          _error = const ApiException(
            ApiErrorKind.validation,
            'Couldn’t read this file. Use a UTF-8 CSV spreadsheet.',
          );
          _action = null;
        });
      }
    }
  }

  Future<void> _preview() async {
    if (_busy || _table == null) return;
    try {
      final rows = mapClientCsv(_table!, _columns);
      // Keep the body below the existing API's 2 MB parser limit after JSON escaping.
      if (utf8.encode(jsonEncode({'rows': rows})).length > maxClientCsvBytes) {
        throw const FormatException(
          'Mapped data exceeds 1 MB. Split the spreadsheet into smaller files.',
        );
      }
      setState(() {
        _action = _ImportAction.preview;
        _error = null;
        _result = null;
        _previewRows = null;
      });
      final auth = context.read<AuthController>();
      final result = await auth.api.importClients(
        auth.business!.id,
        rows,
        dryRun: true,
      );
      if (!mounted) return;
      setState(() {
        _previewRows = rows;
        _result = result;
        _action = null;
        _uncertain = false;
      });
    } on FormatException catch (err) {
      if (mounted) {
        setState(
          () => _error = ApiException(ApiErrorKind.validation, err.message),
        );
      }
    } on ApiException catch (err) {
      if (mounted) {
        setState(() {
          _error = err;
          _action = null;
        });
      }
    }
  }

  Future<void> _import() async {
    final rows = _previewRows;
    final result = _result;
    if (_busy ||
        _uncertain ||
        rows == null ||
        result == null ||
        !result.dryRun ||
        result.valid == 0) {
      return;
    }
    setState(() => _action = _ImportAction.confirm);
    final confirmed = await confirmOwnerAction(
      context,
      'Import ${result.valid} customers?',
      'Valid rows will be imported. Invalid and duplicate rows will be skipped. For existing clients, imported history replaces the earlier import; actual Scalivo visits are kept.',
      label: 'Import customers',
    );
    if (!mounted) return;
    if (!confirmed) {
      setState(() => _action = null);
      return;
    }
    setState(() => _action = _ImportAction.apply);
    final auth = context.read<AuthController>();
    try {
      final saved = await auth.api.importClients(
        auth.business!.id,
        rows,
        dryRun: false,
      );
      if (!mounted) return;
      setState(() {
        _result = saved;
        _previewRows = null;
        _action = null;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${saved.valid} customers imported')),
      );
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() {
        _action = null;
        _uncertain =
            err.kind == ApiErrorKind.network || err.kind == ApiErrorKind.server;
        _error = _uncertain
            ? const ApiException(
                ApiErrorKind.network,
                'Couldn’t verify the import. Check your customer list, then run a fresh preview before importing again.',
              )
            : err;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final table = _table;
    final result = _result;
    return OwnerReportPage(
      title: 'Import customers',
      loading: false,
      error: _error,
      onRefresh: () => _table == null ? _pick() : _preview(),
      children: [
        const Text(
          'Bring your existing customers into Scalivo',
          style: TextStyle(fontSize: 19, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 12),
        const Text(
          'Choose a UTF-8 CSV with a header row. Phone is required; names and visit history are optional. Up to 2,000 customers and 1 MB per file. Importing does not send messages.',
          style: TextStyle(color: Sc.slate),
        ),
        const SizedBox(height: 20),
        ScButton(
          label: table == null ? 'Choose CSV file' : 'Choose another file',
          loading: _action == _ImportAction.pick,
          loadingLabel: 'Working',
          onPressed: _busy ? null : _pick,
        ),
        if (table != null) ...[
          const SizedBox(height: 24),
          ReportSection(
            title: '${table.length - 1} rows · match the columns',
            children: [
              for (final field in clientImportFields)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: DropdownButtonFormField<int>(
                    key: ValueKey(
                      '$field:${_columns[field]}:${table.hashCode}',
                    ),
                    initialValue: _columns[field] ?? -1,
                    isExpanded: true,
                    decoration: InputDecoration(
                      labelText: switch (field) {
                        'phone' => 'Phone (required)',
                        'name' => 'Name',
                        'visits' => 'Previous visits',
                        'spend' => 'Previous spend (rupees)',
                        'firstVisit' => 'First visit',
                        _ => 'Last visit',
                      },
                    ),
                    items: [
                      const DropdownMenuItem(
                        value: -1,
                        child: Text('Not mapped'),
                      ),
                      for (var i = 0; i < table.first.length; i++)
                        DropdownMenuItem(
                          value: i,
                          child: Text(
                            table.first[i],
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                    onChanged: _busy
                        ? null
                        : (index) => setState(() {
                            _columns[field] = index == -1 ? null : index;
                            _result = null;
                            _previewRows = null;
                            _uncertain = false;
                          }),
                  ),
                ),
              const Text(
                'Dates: DD/MM/YYYY or YYYY-MM-DD. Re-importing replaces earlier imported history instead of doubling it.',
                style: TextStyle(color: Sc.slate),
              ),
            ],
          ),
          ScButton(
            label: 'Preview import',
            loading: _action == _ImportAction.preview,
            onPressed: _busy || _columns['phone'] == null ? null : _preview,
          ),
        ],
        if (result != null) ...[
          const SizedBox(height: 24),
          ReportSection(
            title: result.dryRun
                ? 'Preview · no changes made'
                : 'Import complete',
            children: [
              for (final item in [
                ('created', 'New clients'),
                ('linked', 'Existing clients linked'),
                ('updated', 'Profiles updated'),
                ('duplicate', 'Duplicate rows skipped'),
                ('invalid', 'Invalid rows skipped'),
              ])
                ReportMetric(
                  label: item.$2,
                  value: '${result.counts[item.$1]}',
                ),
              for (final problem in result.problems.take(20))
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    'CSV row ${problem.row + 2}: ${problem.reason ?? problem.outcome}',
                    style: const TextStyle(color: Sc.dangerText),
                  ),
                ),
              if (result.problems.length > 20)
                Text(
                  '${result.problems.length - 20} more rows have issues. Correct the source file and preview again.',
                ),
            ],
          ),
          if (result.dryRun)
            ScButton(
              label: 'Import ${result.valid} customers',
              loading: _action == _ImportAction.apply,
              onPressed: _busy || _uncertain || result.valid == 0
                  ? null
                  : _import,
            ),
        ],
      ],
    );
  }
}
