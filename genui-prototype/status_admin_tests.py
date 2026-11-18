#!/usr/bin/env python3
"""Тесты справочника статусов: python status_admin_tests.py (без сторонних пакетов)."""
import json
import tempfile
import unittest
from pathlib import Path

from status_admin import StatusDirectory, StatusError, parse_code, dispatch


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.dir = StatusDirectory(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def group(self, slug):
        return next(g for g in self.dir.list_groups()['items'] if g['slug'] == slug)

    def code(self, value):
        return next(c for c in self.dir.list_codes({'q': str(value), 'page_size': 500})['items'] if c['code'] == value)

    def role(self, name):
        (self.root / '.local-data' / 'access.json').write_text(json.dumps({'statusAdmin': name}), encoding='utf-8')


class Seed(Base):
    def test_seed_groups_and_codes(self):
        groups = self.dir.list_groups()['items']
        self.assertEqual([g['name'] for g in groups][:5], ['Успешная отправка события', 'Техническая обработка', 'Старая политика', 'Стоп-листы', 'Новая политика'])
        self.assertEqual(groups[-1]['slug'], 'ungrouped')
        self.assertEqual(self.group('new-policy')['codes_count'], 10)
        self.assertTrue(all(g['is_system'] for g in groups))

    def test_negative_code_stored(self):
        self.assertEqual(self.code(-1)['description'], 'За определённый срок не было взято в обработку и было удалено')
        self.assertEqual(parse_code('-1'), -1)
        self.assertEqual(parse_code('−1'), -1)

    def test_seed_is_idempotent(self):
        StatusDirectory(self.root)
        self.assertEqual(len(self.dir.list_groups()['items']), 6)


class Validation(Base):
    def test_code_unique_on_create_and_edit(self):
        gid = self.group('technical')['id']
        with self.assertRaises(StatusError) as error:
            self.dir.create_code({'code': 1002, 'description': 'Дубль', 'group_id': gid})
        self.assertEqual(error.exception.status, 409)
        created = self.dir.create_code({'code': 1025, 'description': 'Новый', 'group_id': gid})
        with self.assertRaises(StatusError) as error:
            self.dir.update_code(created['id'], {'code': 1001})
        self.assertEqual(error.exception.status, 409)

    def test_fields(self):
        gid = self.group('technical')['id']
        for bad in ({'code': 'abc', 'description': 'x', 'group_id': gid}, {'code': 1.5, 'description': 'x', 'group_id': gid},
                    {'code': 7, 'description': '  ', 'group_id': gid}, {'code': 7, 'description': 'x', 'group_id': 'a'},
                    {'code': 7, 'description': 'x' * 601, 'group_id': gid}, {'code': True, 'description': 'x', 'group_id': gid}):
            with self.assertRaises(StatusError) as error:
                self.dir.create_code(bad)
            self.assertEqual(error.exception.status, 400)
            self.assertTrue(error.exception.fields)
        with self.assertRaises(StatusError):
            self.dir.create_group({'name': ''})
        with self.assertRaises(StatusError):
            self.dir.create_group({'name': 'X', 'color': 'red'})
        with self.assertRaises(StatusError) as error:
            self.dir.create_group({'name': 'стоп-листы'})
        self.assertEqual(error.exception.status, 409)

    def test_system_protection(self):
        with self.assertRaises(StatusError) as error:
            self.dir.delete_group(self.group('stop-lists')['id'], {})
        self.assertEqual(error.exception.status, 409)
        with self.assertRaises(StatusError):
            self.dir.delete_code(self.code(1002)['id'])
        with self.assertRaises(StatusError):
            self.dir.update_code(self.code(1002)['id'], {'code': 1099})
        updated = self.dir.update_code(self.code(1002)['id'], {'alias': 'Стоп'})
        self.assertEqual(updated['alias'], 'Стоп')

    def test_optimistic_lock(self):
        code = self.code(1001)
        self.dir.update_code(code['id'], {'alias': 'A', 'expected_updated_at': code['updated_at']})
        with self.assertRaises(StatusError) as error:
            self.dir.update_code(code['id'], {'alias': 'B', 'expected_updated_at': '2000-01-01T00:00:00+00:00'})
        self.assertEqual(error.exception.status, 409)


class Changes(Base):
    def test_move_code(self):
        target = self.group('old-policy')['id']
        moved = self.dir.move_code(self.code(1008)['id'], {'group_id': target})
        self.assertEqual(moved['group_id'], target)
        self.assertEqual(self.group('old-policy')['codes_count'], 6)
        with self.assertRaises(StatusError):
            self.dir.move_code(self.code(1008)['id'], {'group_id': 99999})

    def test_reorder(self):
        ids = [g['id'] for g in self.dir.list_groups()['items']][::-1]
        self.dir.reorder_groups({'ids': ids})
        self.assertEqual([g['id'] for g in self.dir.list_groups()['items']], ids)
        with self.assertRaises(StatusError) as error:
            self.dir.reorder_groups({'ids': ids[:-1]})
        self.assertEqual(error.exception.status, 409)
        gid = self.group('technical')['id']
        codes = [c['id'] for c in self.dir.list_codes({'group_id': gid})['items']][::-1]
        result = self.dir.reorder_codes({'group_id': gid, 'ids': codes})
        self.assertEqual([c['id'] for c in result['items']], codes)

    def test_delete_group_moves_codes_to_ungrouped(self):
        group = self.dir.create_group({'name': 'Временная'})
        self.dir.create_code({'code': 7777, 'description': 'Тест', 'group_id': group['id']})
        result = self.dir.delete_group(group['id'], {})
        self.assertEqual(result['moved'], 1)
        self.assertEqual(self.code(7777)['group_id'], self.group('ungrouped')['id'])

    def test_cache_invalidation(self):
        first = self.dir.tree()
        self.assertIs(self.dir.tree(), first)
        self.dir.update_group(self.group('stop-lists')['id'], {'name': 'Стоп-листы массперс'})
        second = self.dir.tree()
        self.assertGreater(second['revision'], first['revision'])
        self.assertIn('Стоп-листы массперс', [g['name'] for g in second['groups']])

    def test_tree_hides_inactive_and_ungrouped_mode(self):
        self.dir.update_group(self.group('technical')['id'], {'is_active': False})
        self.assertNotIn('technical', [g['slug'] for g in self.dir.tree()['groups']])
        self.dir.update_settings({'unassigned_mode': 'hide'})
        self.assertNotIn('ungrouped', [g['slug'] for g in self.dir.tree()['groups']])


class Roles(Base):
    def test_analyst_read_only(self):
        self.role('analyst')
        self.assertTrue(self.dir.list_groups()['items'])
        with self.assertRaises(StatusError) as error:
            self.dir.create_group({'name': 'Нельзя'})
        self.assertEqual(error.exception.status, 403)

    def test_viewer_no_admin(self):
        self.role('viewer')
        with self.assertRaises(StatusError) as error:
            self.dir.list_groups()
        self.assertEqual(error.exception.status, 403)
        self.assertTrue(self.dir.tree()['groups'])  # дашборды viewer видит


class ImportExport(Base):
    def test_roundtrip_and_dry_run(self):
        exported = self.dir.export('json')
        plan = self.dir.import_config({'format': 'json', 'content': exported, 'dry_run': True})
        self.assertEqual(plan['changes'], 0)
        csv_text = 'code;description;group;alias\n1025;Новый код;Техническая обработка;Новый\n-2;Отрицательный;Новая группа;\n1002;Найден в стоплисте;Стоп-листы;Стоп\n'
        plan = self.dir.import_config({'format': 'csv', 'content': csv_text, 'dry_run': True})['plan']
        self.assertEqual(sorted(plan['codes_create']), [-2, 1025])
        self.assertEqual(plan['groups_create'], ['Новая группа'])
        self.assertFalse(self.dir.list_codes({'q': '1025'})['total'])  # dry-run ничего не пишет
        self.dir.import_config({'format': 'csv', 'content': csv_text, 'dry_run': False})
        self.assertEqual(self.code(-2)['description'], 'Отрицательный')
        self.assertEqual(self.code(1002)['alias'], 'Стоп')
        self.assertIn('1025;Новый код', self.dir.export('csv'))

    def test_import_errors_block_apply(self):
        with self.assertRaises(StatusError):
            self.dir.import_config({'format': 'csv', 'content': 'code;description\nabc;x\n', 'dry_run': False})
        plan = self.dir.import_config({'format': 'csv', 'content': 'code;description\n5;a\n5;b\n', 'dry_run': True})['plan']
        self.assertTrue(plan['errors'])

    def test_replace_disables_missing(self):
        content = 'code;description;group\n0;Отправлено;Успешная отправка события\n'
        plan = self.dir.import_config({'format': 'csv', 'content': content, 'mode': 'replace', 'dry_run': True})['plan']
        self.assertIn(1002, plan['codes_disable'])


class Analytics(Base):
    def test_breakdown_sums_to_events(self):
        rows = [{'date': '2026-10-01', 'survey_id': 1, 'status': '0', 'events': 60, 'sends': 60, 'answers': 3},
                {'date': '2026-10-01', 'survey_id': 1, 'status': '1002', 'events': 25, 'sends': 0, 'answers': 0},
                {'date': '2026-10-02', 'survey_id': 1, 'status': '1024', 'events': 10, 'sends': 0, 'answers': 0},
                {'date': '2026-10-02', 'survey_id': 1, 'status': '4242', 'events': 5, 'sends': 0, 'answers': 0}]
        result = self.dir.breakdown(rows, 'group', 'total')
        self.assertEqual(sum(s['points'][0]['events'] for s in result['series']), 100)
        shares = {s['key']: s['points'][0]['share'] for s in result['series']}
        self.assertEqual(shares['stop-lists'], 25)
        self.assertEqual(result['unknown'], [{'code': 4242, 'events': 5}])
        codes = self.dir.breakdown(rows, 'code', 'month')
        self.assertIn('Нет в справочнике', [s['label'] for s in codes['series'] if s['code'] == 4242][0].replace('нет в справочнике', 'Нет в справочнике'))

    def test_disabled_group_goes_to_ungrouped(self):
        self.dir.update_group(self.group('stop-lists')['id'], {'is_active': False})
        rows = [{'date': '2026-10-01', 'survey_id': 1, 'status': '1002', 'events': 7, 'sends': 0, 'answers': 0}]
        series = self.dir.breakdown(rows)['series']
        self.assertEqual([s['key'] for s in series], ['ungrouped'])


class Http(Base):
    def test_dispatch_status_codes(self):
        code, payload, _ = dispatch(self.dir, None, 'GET', '/api/status-groups', {}, {})
        self.assertEqual(code, 200)
        code, payload, _ = dispatch(self.dir, None, 'POST', '/api/status-codes', {}, {'code': -5, 'description': 'Тест', 'group_id': payload['items'][0]['id']})
        self.assertEqual(code, 201)
        with self.assertRaises(StatusError) as error:
            dispatch(self.dir, None, 'PUT', '/api/status-groups', {}, {})
        self.assertEqual(error.exception.status, 405)
        with self.assertRaises(StatusError) as error:
            dispatch(self.dir, None, 'GET', '/api/status-nothing', {}, {})
        self.assertEqual(error.exception.status, 404)
        code, payload, kind = dispatch(self.dir, None, 'GET', '/api/status-config/export', {'format': 'csv'}, {})
        self.assertIn('csv', kind)
        code, page, _ = dispatch(self.dir, None, 'GET', '/api/status-codes', {'page': '2', 'page_size': '5'}, {})
        self.assertEqual((page['page'], len(page['items'])), (2, 5))


if __name__ == '__main__':
    unittest.main(verbosity=1)
