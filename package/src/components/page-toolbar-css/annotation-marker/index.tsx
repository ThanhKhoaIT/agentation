import { Annotation } from "../../../types";
import { IconChatEllipsis, IconEdit, IconPlus, IconXmark } from "../../icons";
import { forceImportantStyles } from "../../../utils/force-important-styles";
import styles from "./styles.module.scss";

type MarkerClickBehavior = "edit" | "delete";

/** Stagger signal rings so neighboring markers don't pulse in sync */
function pulseDelay(index: number): React.CSSProperties {
  return { "--agentation-pulse-delay": `${(index % 4) * 0.4}s` } as React.CSSProperties;
}

// =============================================================================
// AnnotationMarker
// =============================================================================

type AnnotationMarkerProps = {
  annotation: Annotation;
  globalIndex: number;
  /** Display index within this layer (for staggered animation delays) */
  layerIndex: number;
  layerSize: number;
  isExiting: boolean;
  isClearing: boolean;
  isAnimated: boolean;
  isHovered: boolean;
  isDeleting: boolean;
  isEditingAny: boolean;
  renumberFrom: number | null;
  markerClickBehavior: MarkerClickBehavior;
  /** Paint with the accent gradient instead of the solid accent color */
  gradient?: boolean;
  /** Radar-style signal rings around the marker */
  pulse?: boolean;
  tooltipStyle?: React.CSSProperties;
  onHoverEnter: (annotation: Annotation) => void;
  onHoverLeave: () => void;
  onClick: (annotation: Annotation) => void;
  onContextMenu?: (annotation: Annotation) => void;
};

export function AnnotationMarker({
  annotation,
  globalIndex,
  layerIndex,
  layerSize,
  isExiting,
  isClearing,
  isAnimated,
  isHovered,
  isDeleting,
  isEditingAny,
  renumberFrom,
  markerClickBehavior,
  gradient,
  pulse,
  tooltipStyle,
  onHoverEnter,
  onHoverLeave,
  onClick,
  onContextMenu,
}: AnnotationMarkerProps) {
  const showDeleteState = (isHovered || isDeleting) && !isEditingAny;
  const showDeleteHover = showDeleteState && markerClickBehavior === "delete";
  const isMulti = annotation.isMultiSelect;

  const markerColor = isMulti
    ? "var(--agentation-color-green)"
    : "var(--agentation-color-accent)";
  const markerGradient = isMulti
    ? "var(--agentation-gradient-green)"
    : "var(--agentation-gradient-accent)";

  const animClass = isExiting
    ? styles.exit
    : isClearing
      ? styles.clearing
      : !isAnimated
        ? styles.enter
        : "";

  const animationDelay = isExiting
    ? `${(layerSize - 1 - layerIndex) * 20}ms`
    : `${layerIndex * 20}ms`;

  return (
    <div
      id={`agentation-marker-${annotation.id}`}
      className={`${styles.marker} ${isMulti ? styles.multiSelect : ""} ${animClass} ${showDeleteHover ? styles.hovered : ""} ${pulse ? styles.pulse : ""}`}
      data-annotation-marker
      ref={forceImportantStyles({
        "background-color": showDeleteHover
          ? "var(--agentation-color-red)"
          : markerColor,
        // The red delete state stays solid
        "background-image": gradient && !showDeleteHover ? markerGradient : undefined,
        "border-radius": isMulti ? "6px" : "50%",
      })}
      style={{
        left: `${annotation.x}%`,
        top: annotation.y,
        animationDelay,
        ...pulseDelay(globalIndex),
      }}
      onMouseEnter={() => onHoverEnter(annotation)}
      onMouseLeave={onHoverLeave}
      onClick={(e) => {
        e.stopPropagation();
        if (!isExiting) onClick(annotation);
      }}
      onContextMenu={
        onContextMenu
          ? (e) => {
              if (markerClickBehavior === "delete") {
                e.preventDefault();
                e.stopPropagation();
                if (!isExiting) onContextMenu(annotation);
              }
            }
          : undefined
      }
    >
      {showDeleteState ? (
        showDeleteHover ? (
          <IconXmark size={isMulti ? 18 : 16} />
        ) : (
          <IconEdit size={16} />
        )
      ) : (
        <span
          className={
            renumberFrom !== null && globalIndex >= renumberFrom
              ? styles.renumber
              : undefined
          }
        >
          {globalIndex + 1}
        </span>
      )}

      {isHovered && !isEditingAny && (
        <div
          className={`${styles.markerTooltip} ${styles.enter}`}
          style={tooltipStyle}
        >
          <span className={styles.markerQuote}>
            {annotation.element}
            {annotation.selectedText &&
              ` "${annotation.selectedText.slice(0, 30)}${annotation.selectedText.length > 30 ? "..." : ""}"`}
          </span>
          <span className={styles.markerNote}>{annotation.comment}</span>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// SharedMarker
// =============================================================================

type SharedMarkerProps = {
  annotation: Annotation;
  isHovered: boolean;
  /** Radar-style signal rings around the marker */
  pulse?: boolean;
  /** Position among the shared markers, to stagger the rings */
  index?: number;
  tooltipStyle?: React.CSSProperties;
  onHoverEnter: (annotation: Annotation) => void;
  onHoverLeave: () => void;
};

/**
 * Read-only marker for an annotation someone else left on this page.
 */
export function SharedMarker({
  annotation,
  isHovered,
  pulse,
  index = 0,
  tooltipStyle,
  onHoverEnter,
  onHoverLeave,
}: SharedMarkerProps) {
  const author = annotation.authorId?.split("@")[0];
  return (
    <div
      id={`agentation-shared-marker-${annotation.id}`}
      className={`${styles.marker} ${styles.shared} ${styles.enter} ${pulse ? styles.pulse : ""}`}
      data-annotation-marker
      ref={forceImportantStyles({
        "background-color": "var(--agentation-shared-fallback)",
        "background-image": "var(--agentation-shared-gradient)",
        "border-radius": "50%",
      })}
      style={{
        left: `${annotation.x}%`,
        top: annotation.y,
        ...pulseDelay(index),
      }}
      onMouseEnter={() => onHoverEnter(annotation)}
      onMouseLeave={onHoverLeave}
      onClick={(e) => e.stopPropagation()}
    >
      <IconChatEllipsis size={14} />

      {isHovered && (
        <div
          className={`${styles.markerTooltip} ${styles.enter}`}
          style={tooltipStyle}
        >
          <span className={styles.markerQuote}>{annotation.element}</span>
          <span className={styles.markerNote}>{annotation.comment}</span>
          {author && <span className={styles.markerAuthor}>{author}</span>}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// PendingMarker
// =============================================================================

type PendingMarkerProps = {
  x: number;
  y: number;
  isMultiSelect?: boolean;
  isExiting: boolean;
  gradient?: boolean;
};

export function PendingMarker({
  x,
  y,
  isMultiSelect,
  isExiting,
  gradient,
}: PendingMarkerProps) {
  return (
    <div
      id="agentation-marker-pending"
      className={`${styles.marker} ${styles.pending} ${isMultiSelect ? styles.multiSelect : ""} ${isExiting ? styles.exit : styles.enter}`}
      ref={forceImportantStyles({
        "background-color": isMultiSelect
          ? "var(--agentation-color-green)"
          : "var(--agentation-color-accent)",
        "background-image": gradient
          ? isMultiSelect
            ? "var(--agentation-gradient-green)"
            : "var(--agentation-gradient-accent)"
          : undefined,
        "border-radius": isMultiSelect ? "6px" : "50%",
      })}
      style={{
        left: `${x}%`,
        top: y,
      }}
    >
      <IconPlus size={12} />
    </div>
  );
}

// =============================================================================
// ExitingMarker
// =============================================================================

type ExitingMarkerProps = {
  annotation: Annotation;
  fixed?: boolean;
};

export function ExitingMarker({ annotation, fixed }: ExitingMarkerProps) {
  const isMulti = annotation.isMultiSelect;
  return (
    <div
      id={`agentation-marker-exiting-${annotation.id}`}
      className={`${styles.marker} ${fixed ? styles.fixed : ""} ${styles.hovered} ${isMulti ? styles.multiSelect : ""} ${styles.exit}`}
      data-annotation-marker
      ref={forceImportantStyles({
        "background-color": "var(--agentation-color-red)",
        "border-radius": isMulti ? "6px" : "50%",
      })}
      style={{
        left: `${annotation.x}%`,
        top: annotation.y,
      }}
    >
      <IconXmark size={isMulti ? 12 : 10} />
    </div>
  );
}
