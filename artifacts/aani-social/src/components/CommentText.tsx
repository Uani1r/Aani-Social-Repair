import React from 'react';

import { createMentionRegex } from '../lib/mentions';

/**
 * يعرض نص التعليق باتجاه عربي ثابت (RTL) مع إبراز أسماء المستخدمين المذكورين
 * بدون رمز @، وتبقى الكلمات الإنجليزية تُقرأ بشكل صحيح داخل الجملة.
 */
const CommentText: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const nodes: React.ReactNode[] = [];
  const regex = createMentionRegex();

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const start = match.index;

    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));

    const token = match[1] ?? '';
    nodes.push(
      <span key={`mention-${start}`} className="font-semibold text-pink-400">
        {token}
      </span>,
    );

    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));

  return (
    <span
      className={className}
      dir="rtl"
      style={{ unicodeBidi: 'isolate', textAlign: 'right' }}
    >
      {nodes.length ? nodes : text}
    </span>
  );
};

export default CommentText;
