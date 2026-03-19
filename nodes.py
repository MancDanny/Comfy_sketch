import torch
import numpy as np
import os
import hashlib
import base64
import io
from PIL import Image, ImageOps
import folder_paths


class SketchPad:
    """
    Combined image loader + interactive drawing canvas.
    Load an image, draw colored annotations (R/G/B), and output
    the original image, annotated image, and per-color masks.
    """

    @classmethod
    def INPUT_TYPES(s):
        input_dir = folder_paths.get_input_directory()
        files = sorted(
            [f for f in os.listdir(input_dir)
             if os.path.isfile(os.path.join(input_dir, f))]
        )
        return {
            "required": {
                "image": (files, {"image_upload": True}),
            },
            "hidden": {
                "canvas_data": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK", "MASK", "MASK", "MASK")
    RETURN_NAMES = (
        "original_image", "annotated_image",
        "red_mask", "green_mask", "blue_mask", "combined_mask"
    )
    FUNCTION = "execute"
    CATEGORY = "image/sketch"

    def execute(self, image, canvas_data=""):
        # Load original image (same pattern as built-in LoadImage)
        image_path = folder_paths.get_annotated_filepath(image)
        img = Image.open(image_path)
        img = ImageOps.exif_transpose(img)

        if img.mode == "I":
            img = img.point(lambda i: i * (1 / 255))

        original_pil = img.convert("RGB")
        original_np = np.array(original_pil).astype(np.float32) / 255.0
        original_tensor = torch.from_numpy(original_np)[None,]

        h, w = original_np.shape[:2]

        if canvas_data and canvas_data.strip():
            # Strip data URL prefix if present
            data = canvas_data
            if data.startswith("data:"):
                data = data.split(",", 1)[1]

            canvas_bytes = base64.b64decode(data)
            canvas_img = Image.open(io.BytesIO(canvas_bytes)).convert("RGBA")

            # Resize canvas to match source image dimensions
            if canvas_img.size != (w, h):
                canvas_img = canvas_img.resize((w, h), Image.LANCZOS)

            canvas_np = np.array(canvas_img).astype(np.float32) / 255.0

            alpha = canvas_np[:, :, 3]
            r_ch = canvas_np[:, :, 0]
            g_ch = canvas_np[:, :, 1]
            b_ch = canvas_np[:, :, 2]

            # Extract per-color masks via channel thresholding
            red_mask_np = (
                (r_ch > 0.5) & (g_ch < 0.3) & (b_ch < 0.3) & (alpha > 0.1)
            ).astype(np.float32)

            green_mask_np = (
                (g_ch > 0.5) & (r_ch < 0.3) & (b_ch < 0.3) & (alpha > 0.1)
            ).astype(np.float32)

            blue_mask_np = (
                (b_ch > 0.5) & (r_ch < 0.3) & (g_ch < 0.3) & (alpha > 0.1)
            ).astype(np.float32)

            combined_mask_np = (alpha > 0.1).astype(np.float32)

            # Composite annotated image: original blended with drawing overlay
            overlay_rgb = canvas_np[:, :, :3]
            alpha_3ch = alpha[:, :, np.newaxis]
            annotated_np = original_np * (1 - alpha_3ch) + overlay_rgb * alpha_3ch
            annotated_tensor = torch.from_numpy(annotated_np)[None,]
        else:
            # No drawing — blank masks, original as annotated
            annotated_tensor = original_tensor.clone()
            red_mask_np = np.zeros((h, w), dtype=np.float32)
            green_mask_np = np.zeros((h, w), dtype=np.float32)
            blue_mask_np = np.zeros((h, w), dtype=np.float32)
            combined_mask_np = np.zeros((h, w), dtype=np.float32)

        red_mask = torch.from_numpy(red_mask_np)[None,]
        green_mask = torch.from_numpy(green_mask_np)[None,]
        blue_mask = torch.from_numpy(blue_mask_np)[None,]
        combined_mask = torch.from_numpy(combined_mask_np)[None,]

        return (
            original_tensor, annotated_tensor,
            red_mask, green_mask, blue_mask, combined_mask
        )

    @classmethod
    def IS_CHANGED(s, image, canvas_data=""):
        m = hashlib.sha256()
        image_path = folder_paths.get_annotated_filepath(image)
        with open(image_path, "rb") as f:
            m.update(f.read())
        m.update((canvas_data or "").encode("utf-8"))
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(s, image, canvas_data=""):
        if not folder_paths.exists_annotated_filepath(image):
            return "Invalid image file: {}".format(image)
        return True


NODE_CLASS_MAPPINGS = {
    "SketchPad": SketchPad
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SketchPad": "Sketch Pad"
}
