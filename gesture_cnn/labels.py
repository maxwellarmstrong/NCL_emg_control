"""Stable movement and continuous-target mappings for the guided-trial app."""

MOVEMENTS = (
    (0, "rest"),
    (1, "open_hand"),
    (2, "fist"),
    (3, "pinch"),
    (4, "bicep_curl"),
    (5, "elbow_extend"),
    (6, "arm_raise_forward"),
    (7, "arm_raise_side"),
    (8, "forearm_supination"),
    (9, "forearm_pronation"),
    (10, "wrist_flexion"),
    (11, "wrist_extension"),
    (12, "wrist_radial_deviation"),
    (13, "wrist_ulnar_deviation"),
    (14, "release_pinch"),
    (15, "arm_lower_forward"),
    (16, "arm_lower_side"),
)

CLASS_TO_ID = {name: class_id for class_id, name in MOVEMENTS}
ID_TO_CLASS = {class_id: name for class_id, name in MOVEMENTS}

# Motion targets are stored in this order. Finger values are calibrated 0..1
# bend estimates; the two arm values are camera-estimated degrees normalized
# by 180 for training and converted back to degrees for reports/inference.
MOTION_TARGETS = (
    "thumb_flexion",
    "index_flexion",
    "middle_flexion",
    "ring_flexion",
    "little_flexion",
    "elbow_flexion_deg",
    "upper_arm_to_torso_deg",
)
TARGET_SCALES = (1.0, 1.0, 1.0, 1.0, 1.0, 180.0, 180.0)

_HAND = {"open_hand", "fist", "pinch", "release_pinch"}
_ELBOW = {"bicep_curl", "elbow_extend"}
_SHOULDER = {"arm_raise_forward", "arm_raise_side", "arm_lower_forward", "arm_lower_side"}


def target_mask_for_movement(name):
    """Only supervise the camera target relevant to this prompted movement."""
    mask = [False] * len(MOTION_TARGETS)
    if name == "rest":
        return [True] * len(MOTION_TARGETS)
    if name in _HAND:
        mask[:5] = [True] * 5
    elif name in _ELBOW:
        mask[5] = True
    elif name in _SHOULDER:
        mask[6] = True
    # The current monocular camera does not measure forearm rotation or wrist
    # direction. Their class labels are still trainable; their motion mask stays off.
    return mask
