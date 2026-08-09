import 'package:image_picker/image_picker.dart';

import 'package:mbs_mobile_flutter/core/sync/sync_engine.dart';

class PhotoUploadService {
  PhotoUploadService(this._syncEngine);

  final SyncEngine _syncEngine;
  final ImagePicker _picker = ImagePicker();

  Future<void> captureForJob({
    required String jobId,
    String tag = 'PROBLEM',
  }) async {
    final image = await _picker.pickImage(
      source: ImageSource.camera,
      imageQuality: 85,
    );
    if (image == null) {
      return;
    }
    await _syncEngine.enqueuePhotoUpload(
      localPath: image.path,
      ownerType: 'JOB',
      ownerId: jobId,
      tag: tag,
    );
  }

  Future<void> selectFromLibraryForJob({
    required String jobId,
    String tag = 'OTHER',
  }) async {
    final image = await _picker.pickImage(
      source: ImageSource.gallery,
      imageQuality: 90,
    );
    if (image == null) {
      return;
    }
    await _syncEngine.enqueuePhotoUpload(
      localPath: image.path,
      ownerType: 'JOB',
      ownerId: jobId,
      tag: tag,
    );
  }
}
