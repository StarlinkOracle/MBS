import 'dart:convert';

import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';
import 'package:uuid/uuid.dart';

part 'local_database.g.dart';

class QueuedActions extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get clientActionId => text()();
  TextColumn get toolName => text()();
  TextColumn get payloadJson => text()();
  TextColumn get reason => text().nullable()();
  TextColumn get status => text().withDefault(const Constant('PENDING'))();
  TextColumn get error => text().nullable()();
  TextColumn get localFilePath => text().nullable()();
  IntColumn get retryCount => integer().withDefault(const Constant(0))();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column<Object>> get uniqueKeys => {
        {clientActionId},
      };
}

class AppointmentsCache extends Table {
  TextColumn get id => text()();
  TextColumn get dateKey => text()();
  TextColumn get timeBlockCode => text().nullable()();
  TextColumn get type => text().nullable()();
  TextColumn get status => text().nullable()();
  TextColumn get jobId => text().nullable()();
  TextColumn get customerId => text().nullable()();
  TextColumn get payloadJson => text()();
  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

class JobsCache extends Table {
  TextColumn get id => text()();
  TextColumn get title => text().nullable()();
  TextColumn get status => text().nullable()();
  TextColumn get payloadJson => text()();
  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

class CustomersCache extends Table {
  TextColumn get id => text()();
  TextColumn get fullName => text().nullable()();
  TextColumn get phone => text().nullable()();
  TextColumn get payloadJson => text()();
  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

class TimeEntriesCache extends Table {
  TextColumn get id => text()();
  TextColumn get userId => text().nullable()();
  TextColumn get type => text().nullable()();
  TextColumn get status => text().nullable()();
  TextColumn get startedAt => text().nullable()();
  TextColumn get endedAt => text().nullable()();
  TextColumn get payloadJson => text()();
  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

class DispatchBlocksCache extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get dateKey => text()();
  TextColumn get blockCode => text()();
  TextColumn get payloadJson => text()();
  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Set<Column<Object>>> get uniqueKeys => {
        {dateKey, blockCode},
      };
}

class TimeEditRequestsCache extends Table {
  TextColumn get id => text()();
  TextColumn get status => text().nullable()();
  TextColumn get payloadJson => text()();
  DateTimeColumn get createdAt => dateTime().nullable()();
  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

class SyncStateTable extends Table {
  IntColumn get id => integer().withDefault(const Constant(1))();
  TextColumn get deviceId => text()();
  TextColumn get auditCursor => text().nullable()();
  TextColumn get outboxCursor => text().nullable()();
  DateTimeColumn get lastSyncAt => dateTime().nullable()();
  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

@DriftDatabase(
  tables: [
    QueuedActions,
    AppointmentsCache,
    JobsCache,
    CustomersCache,
    TimeEntriesCache,
    DispatchBlocksCache,
    TimeEditRequestsCache,
    SyncStateTable,
  ],
)
class LocalDatabase extends _$LocalDatabase {
  LocalDatabase() : super(_openConnection());

  @override
  int get schemaVersion => 1;

  final Uuid _uuid = const Uuid();

  Future<QueuedAction> enqueueAction({
    required String toolName,
    required Map<String, dynamic> payload,
    String? reason,
    String? localFilePath,
    String? clientActionId,
  }) async {
    final id = clientActionId ?? _uuid.v4();
    await into(queuedActions).insert(
      QueuedActionsCompanion.insert(
        clientActionId: id,
        toolName: toolName,
        payloadJson: jsonEncode(payload),
        reason: Value(reason),
        localFilePath: Value(localFilePath),
      ),
      mode: InsertMode.insertOrReplace,
    );
    return (select(queuedActions)..where((tbl) => tbl.clientActionId.equals(id)))
        .getSingle();
  }

  Future<List<QueuedAction>> listPendingActions() {
    return (select(queuedActions)
          ..where((tbl) => tbl.status.isIn(const ['PENDING', 'FAILED']))
          ..orderBy([(tbl) => OrderingTerm.asc(tbl.createdAt)]))
        .get();
  }

  Future<List<QueuedAction>> listFailedActions() {
    return (select(queuedActions)
          ..where((tbl) => tbl.status.equals('FAILED'))
          ..orderBy([(tbl) => OrderingTerm.asc(tbl.createdAt)]))
        .get();
  }

  Future<void> markActionStatus({
    required String clientActionId,
    required String status,
    String? error,
    bool incrementRetry = false,
  }) async {
    await (update(queuedActions)
          ..where((tbl) => tbl.clientActionId.equals(clientActionId)))
        .write(
      QueuedActionsCompanion(
        status: Value(status),
        error: Value(error),
        retryCount: incrementRetry
            ? const Value.absent()
            : const Value.absent(),
        updatedAt: Value(DateTime.now()),
      ),
    );
    if (incrementRetry) {
      await customStatement(
        'UPDATE queued_actions SET retry_count = retry_count + 1 WHERE client_action_id = ?',
        [clientActionId],
      );
    }
  }

  Future<void> clearConfirmedActions() async {
    await (delete(queuedActions)
          ..where((tbl) => tbl.status.equals('CONFIRMED')))
        .go();
  }

  Future<void> retryFailedAction(String clientActionId) async {
    await (update(queuedActions)
          ..where((tbl) => tbl.clientActionId.equals(clientActionId)))
        .write(
      QueuedActionsCompanion(
        status: const Value('PENDING'),
        error: const Value(null),
        updatedAt: Value(DateTime.now()),
      ),
    );
  }

  Future<void> retryAllFailedActions() async {
    await customStatement(
      "UPDATE queued_actions SET status = 'PENDING', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'FAILED'",
    );
  }

  Future<SyncStateTableData?> getSyncState() async {
    return (select(syncStateTable)..where((tbl) => tbl.id.equals(1)))
        .getSingleOrNull();
  }

  Future<void> upsertSyncState({
    required String deviceId,
    String? auditCursor,
    String? outboxCursor,
    DateTime? lastSyncAt,
  }) async {
    await into(syncStateTable).insert(
      SyncStateTableCompanion.insert(
        id: const Value(1),
        deviceId: deviceId,
        auditCursor: Value(auditCursor),
        outboxCursor: Value(outboxCursor),
        lastSyncAt: Value(lastSyncAt),
      ),
      mode: InsertMode.insertOrReplace,
    );
  }

  Future<void> applyReadModels(Map<String, dynamic> readModels) async {
    final now = DateTime.now();
    final todaySchedule =
        (readModels['todaySchedule'] as Map?)?.cast<String, dynamic>() ?? const {};
    final dispatchDay =
        (readModels['dispatchDay'] as Map?)?.cast<String, dynamic>() ?? const {};
    final entities =
        (readModels['entities'] as Map?)?.cast<String, dynamic>() ?? const {};

    await transaction(() async {
      final appointments = (todaySchedule['appointments'] as List?)
              ?.whereType<Map>()
              .map((row) => row.cast<String, dynamic>())
              .toList() ??
          const <Map<String, dynamic>>[];
      for (final row in appointments) {
        final appointmentId = (row['id'] ?? '').toString();
        if (appointmentId.isEmpty) continue;
        await into(appointmentsCache).insert(
          AppointmentsCacheCompanion.insert(
            id: appointmentId,
            dateKey: Value((todaySchedule['date'] ?? '').toString()),
            timeBlockCode: Value(row['timeBlockCode']?.toString()),
            type: Value(row['type']?.toString()),
            status: Value(row['status']?.toString()),
            jobId: Value(row['jobId']?.toString()),
            customerId: Value(row['customerId']?.toString()),
            payloadJson: jsonEncode(row),
            updatedAt: Value(now),
          ),
          mode: InsertMode.insertOrReplace,
        );
      }

      final timeEntries = (todaySchedule['timeEntries'] as List?)
              ?.whereType<Map>()
              .map((row) => row.cast<String, dynamic>())
              .toList() ??
          const <Map<String, dynamic>>[];
      for (final row in timeEntries) {
        final id = (row['id'] ?? '').toString();
        if (id.isEmpty) continue;
        await into(timeEntriesCache).insert(
          TimeEntriesCacheCompanion.insert(
            id: id,
            userId: Value(row['userId']?.toString()),
            type: Value(row['type']?.toString()),
            status: Value(row['status']?.toString()),
            startedAt: Value(row['startedAt']?.toString()),
            endedAt: Value(row['endedAt']?.toString()),
            payloadJson: jsonEncode(row),
            updatedAt: Value(now),
          ),
          mode: InsertMode.insertOrReplace,
        );
      }

      final blocks = (dispatchDay['blocks'] as List?)
              ?.whereType<Map>()
              .map((row) => row.cast<String, dynamic>())
              .toList() ??
          const <Map<String, dynamic>>[];
      final dateKey = (dispatchDay['date'] ?? '').toString();
      for (final row in blocks) {
        final blockCode = (row['code'] ?? '').toString();
        if (blockCode.isEmpty) continue;
        await into(dispatchBlocksCache).insert(
          DispatchBlocksCacheCompanion.insert(
            dateKey: dateKey,
            blockCode: blockCode,
            payloadJson: jsonEncode(row),
            updatedAt: Value(now),
          ),
          mode: InsertMode.insertOrReplace,
        );
      }

      final editRequests = (entities['timeEditRequests'] as List?)
              ?.whereType<Map>()
              .map((row) => row.cast<String, dynamic>())
              .toList() ??
          const <Map<String, dynamic>>[];
      for (final row in editRequests) {
        final id = (row['id'] ?? '').toString();
        if (id.isEmpty) continue;
        await into(timeEditRequestsCache).insert(
          TimeEditRequestsCacheCompanion.insert(
            id: id,
            status: Value(row['status']?.toString()),
            payloadJson: jsonEncode(row),
            createdAt: Value(
              row['createdAt'] is String
                  ? DateTime.tryParse(row['createdAt'].toString())
                  : null,
            ),
            updatedAt: Value(now),
          ),
          mode: InsertMode.insertOrReplace,
        );
      }
    });
  }
}

QueryExecutor _openConnection() {
  return driftDatabase(
    name: 'mbs_mobile.sqlite',
    native: const DriftNativeOptions(
      databaseDirectory: getApplicationDocumentsDirectory,
    ),
  );
}
