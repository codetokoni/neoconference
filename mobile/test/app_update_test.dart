import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/core/app_update.dart';

void main() {
  test('app versions compare by number, not as text', () {
    expect(compareAppVersions('1.2.3', '1.2.4'), -1);
    expect(compareAppVersions('1.2.4', '1.2.4'), 0);
    expect(compareAppVersions('1.2.10', '1.2.9'), 1);
    expect(compareAppVersions('1.3', '1.2.9'), 1);
    expect(compareAppVersions('1.2', '1.2.0'), 0);
  });
}
