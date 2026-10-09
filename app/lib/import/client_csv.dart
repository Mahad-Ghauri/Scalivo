import 'dart:convert';
import 'dart:typed_data';

import 'package:csv/csv.dart';

const maxClientCsvBytes = 1024 * 1024;
const clientImportFields = [
  'phone',
  'name',
  'visits',
  'spend',
  'firstVisit',
  'lastVisit',
];

/// Run in an isolate: a large quoted spreadsheet must not block the UI thread.
List<List<String>> parseClientCsv(Uint8List bytes) {
  if (bytes.isEmpty || bytes.length > maxClientCsvBytes) {
    throw const FormatException('Choose a CSV file of up to 1 MB');
  }
  final text = utf8.decode(bytes).replaceFirst(RegExp(r'^\uFEFF'), '');
  // Match spreadsheet delimiter detection used by the existing web importer.
  final firstLine = text.split(RegExp(r'\r?\n')).first;
  final delimiter = [',', ';', '\t'].reduce(
    (best, candidate) =>
        firstLine.split(candidate).length > firstLine.split(best).length
        ? candidate
        : best,
  );
  final rows =
      const CsvToListConverter(shouldParseNumbers: false, allowInvalid: false)
          .convert(
            text,
            fieldDelimiter: delimiter,
            eol: text.contains('\r\n') ? '\r\n' : '\n',
          )
          .where((row) => row.any((cell) => cell.toString().trim().isNotEmpty))
          .map(
            (row) => row
                .map((cell) => cell.toString().trim())
                .toList(growable: false),
          )
          .toList(growable: false);
  if (rows.length < 2 ||
      rows.length > 2001 ||
      rows.first.length > 20 ||
      rows.first.any((cell) => cell.isEmpty) ||
      rows.any(
        (row) =>
            row.length != rows.first.length ||
            row.any((cell) => cell.length > 2000),
      )) {
    throw const FormatException(
      'Use a header row and 1–2,000 customers, with up to 20 columns',
    );
  }
  if (rows.first.toSet().length != rows.first.length) {
    throw const FormatException('Give each column a unique header');
  }
  return rows;
}

List<Map<String, String>> mapClientCsv(
  List<List<String>> table,
  Map<String, int?> columns,
) {
  final selected = columns.values.whereType<int>().toList();
  if (table.length < 2 ||
      table.length > 2001 ||
      columns['phone'] == null ||
      columns.keys.any((key) => !clientImportFields.contains(key)) ||
      selected.any((index) => index < 0 || index >= table.first.length) ||
      selected.toSet().length != selected.length) {
    throw const FormatException(
      'Map a phone column and use each column only once',
    );
  }
  return [
    for (final row in table.skip(1))
      {
        for (final field in clientImportFields)
          if (columns[field] != null) field: row[columns[field]!],
      },
  ];
}
