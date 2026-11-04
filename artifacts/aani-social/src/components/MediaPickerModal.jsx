import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function MediaPickerModal({ isOpen, onClose, onSelectComplete, existingImages = [] }) {
  const [activeTab, setActiveTab] = useState('photos');
  const [selectedIds, setSelectedIds] = useState([]);
  const [photos, setPhotos] = useState([]);
  const imageInputRef = useRef(null);
  const objectUrlsRef = useRef(new Set());

  useEffect(() => () => {
    objectUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    objectUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!isOpen || !existingImages.length) return;

    const initialPhotos = existingImages.map((file, index) => {
      const url = URL.createObjectURL(file);
      objectUrlsRef.current.add(url);
      return { id: `existing-${file.name}-${file.lastModified}-${index}`, file, url };
    });
    setPhotos(initialPhotos);
    setSelectedIds(initialPhotos.map(photo => photo.id));
  }, [isOpen, existingImages]);

  if (!isOpen) return null;

  const openDevicePicker = () => imageInputRef.current?.click();

  const handleFilesChange = event => {
    const files = Array.from(event.currentTarget.files || []).filter(file => file.type.startsWith('image/'));
    event.currentTarget.value = '';
    if (!files.length) return;

    const addedPhotos = files.map((file, index) => {
      const url = URL.createObjectURL(file);
      objectUrlsRef.current.add(url);
      return { id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`, file, url };
    });

    setPhotos(current => [...current, ...addedPhotos]);
    setSelectedIds(current => [...new Set([...current, ...addedPhotos.map(photo => photo.id)])]);
  };

  const toggleSelect = id => {
    setSelectedIds(current => current.includes(id)
      ? current.filter(item => item !== id)
      : [...current, id]);
  };

  const handleConfirm = () => {
    const chosenPhotos = photos
      .filter(photo => selectedIds.includes(photo.id))
      .map(photo => photo.file);
    if (chosenPhotos.length) onSelectComplete?.(chosenPhotos);
    onClose();
  };

  return createPortal(
    <div style={styles.overlay}>
      <div style={styles.container} role="dialog" aria-modal="true" aria-label="اختيار الصور" dir="rtl">
        <header style={styles.header}>
          <button type="button" style={styles.checkBtn} onClick={handleConfirm} title="تأكيد الاختيار" aria-label="تأكيد الاختيار">
            ✓
          </button>

          <div style={styles.tabContainer} role="tablist" aria-label="نوع الوسائط">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'albums'}
              style={{ ...styles.tab, ...(activeTab === 'albums' ? styles.activeTab : {}) }}
              onClick={() => setActiveTab('albums')}
            >
              المجموعات
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'photos'}
              style={{ ...styles.tab, ...(activeTab === 'photos' ? styles.activeTab : {}) }}
              onClick={() => setActiveTab('photos')}
            >
              الصور
            </button>
          </div>

          <button type="button" style={styles.closeBtn} onClick={onClose} title="إغلاق" aria-label="إغلاق">
            ✕
          </button>
        </header>

        <div style={styles.gridContainer}>
          {photos.map(photo => {
            const isSelected = selectedIds.includes(photo.id);
            return (
              <button
                type="button"
                key={photo.id}
                style={styles.gridItem}
                onClick={() => toggleSelect(photo.id)}
                aria-label={isSelected ? 'إلغاء تحديد الصورة' : 'تحديد الصورة'}
                aria-pressed={isSelected}
              >
                <img src={photo.url} alt={photo.file.name || 'صورة من الجهاز'} style={styles.thumbImage} />
                <span style={{ ...styles.checkbox, ...(isSelected ? styles.checkboxSelected : {}) }}>
                  {isSelected && '✓'}
                </span>
              </button>
            );
          })}

          <button type="button" style={styles.addPhotoTile} onClick={openDevicePicker}>
            <span style={styles.addPhotoIcon}>＋</span>
            <span>اختيار صور من الجهاز</span>
          </button>
        </div>

        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          style={styles.hiddenInput}
          onChange={handleFilesChange}
        />

        <div style={styles.bottomFloatingBar}>
          <button type="button" style={styles.iconCircleBtn} onClick={openDevicePicker} title="إضافة صور من الجهاز" aria-label="إضافة صور من الجهاز">
            🔍
          </button>
          <button type="button" style={styles.selectedCountBtn} onClick={handleConfirm} disabled={!selectedIds.length}>
            إظهار ما تم تحديده ({selectedIds.length})
          </button>
          <button type="button" style={styles.iconCircleBtn} onClick={() => setActiveTab('albums')} title="المجموعات" aria-label="عرض المجموعات">
            •••
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const styles = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000000',
    zIndex: 9999,
    display: 'flex',
    justifyContent: 'center',
    direction: 'rtl',
    fontFamily: "'Tajawal', sans-serif",
  },
  container: {
    width: '100%',
    maxWidth: '430px',
    height: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    backgroundColor: '#0a0a0a',
    overflow: 'hidden',
  },
  header: {
    padding: 'calc(16px + env(safe-area-inset-top)) 20px 16px',
    display: 'flex',
    direction: 'ltr',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#0a0a0a',
    borderBottom: '1px solid #1a1a1a',
    flexShrink: 0,
  },
  checkBtn: {
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    backgroundColor: '#1a8cff',
    color: '#ffffff',
    border: 'none',
    fontSize: '18px',
    fontWeight: 'bold',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtn: {
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    backgroundColor: '#1c1c1e',
    color: '#ffffff',
    border: 'none',
    fontSize: '18px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabContainer: {
    display: 'flex',
    backgroundColor: '#1c1c1e',
    padding: '4px',
    borderRadius: '20px',
    gap: '4px',
  },
  tab: {
    padding: '6px 18px',
    borderRadius: '16px',
    border: 'none',
    backgroundColor: 'transparent',
    color: '#8e8e93',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
  },
  activeTab: {
    backgroundColor: '#ffffff',
    color: '#000000',
  },
  gridContainer: {
    flex: 1,
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '2px',
    padding: '2px',
    overflowY: 'auto',
    paddingBottom: '110px',
  },
  gridItem: {
    position: 'relative',
    aspectRatio: '1',
    backgroundColor: '#1a1a1a',
    cursor: 'pointer',
    overflow: 'hidden',
    border: 'none',
    padding: 0,
  },
  thumbImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  checkbox: {
    position: 'absolute',
    top: '8px',
    right: '8px',
    width: '24px',
    height: '24px',
    borderRadius: '50%',
    border: '2px solid rgba(255,255,255,0.7)',
    backgroundColor: 'rgba(0,0,0,0.3)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#ffffff',
    fontSize: '12px',
    fontWeight: 'bold',
  },
  checkboxSelected: {
    backgroundColor: '#1a8cff',
    borderColor: '#1a8cff',
  },
  addPhotoTile: {
    aspectRatio: '1',
    backgroundColor: '#1a1a1a',
    border: '1px dashed #555',
    color: '#ffffff',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    padding: '12px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  addPhotoIcon: {
    fontSize: '30px',
    lineHeight: 1,
  },
  hiddenInput: {
    display: 'none',
  },
  bottomFloatingBar: {
    position: 'absolute',
    bottom: 'calc(24px + env(safe-area-inset-bottom))',
    left: '20px',
    right: '20px',
    display: 'flex',
    direction: 'ltr',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    backgroundColor: 'rgba(28, 28, 30, 0.92)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    padding: '8px 12px',
    borderRadius: '30px',
    boxShadow: '0 8px 20px rgba(0,0,0,0.5)',
  },
  iconCircleBtn: {
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    border: 'none',
    backgroundColor: 'rgba(255,255,255,0.1)',
    color: '#ffffff',
    fontSize: '16px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  selectedCountBtn: {
    flex: 1,
    padding: '10px 16px',
    borderRadius: '20px',
    border: 'none',
    backgroundColor: '#e5e5ea',
    color: '#000000',
    fontSize: '14px',
    fontWeight: '700',
    cursor: 'pointer',
    textAlign: 'center',
  },
};
