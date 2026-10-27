import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReviewSummary } from '../src/reviewSummary.js';

test('baseline daily and weekly summaries preserve the current review behavior', () => {
  assert.equal(formatReviewSummary('daily_review', '출시', ['ev-1:issue']), '일간 점검: 출시');
  assert.equal(formatReviewSummary('weekly_review', '출시', []), '주간 점검: 출시');
});
