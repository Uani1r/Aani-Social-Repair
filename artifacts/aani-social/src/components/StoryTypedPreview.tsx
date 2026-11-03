import { useEffect, useRef, useState } from 'react';

// معاينة حيّة لحركة «الآلة الكاتبة»: تكتب النص حرفاً حرفاً بعد مؤشر وامض
export default function StoryTypedPreview({ text, animate }: { text: string; animate: boolean }) {
  const [count, setCount] = useState(0);
  const [done, setDone] = useState(false);
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    if (!animate) {
      setDone(true);
      return;
    }

    setCount(0);
    setDone(false);
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setCount(index);
      if (index >= textRef.current.length) {
        window.clearInterval(timer);
        setDone(true);
      }
    }, 60);

    return () => window.clearInterval(timer);
  }, [animate]);

  if (!animate || done) return <>{text}</>;

  return (
    <>
      {text.slice(0, count)}
      <span className="aani-story-caret">|</span>
    </>
  );
}
