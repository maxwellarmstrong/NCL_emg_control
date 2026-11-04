//! WebGL2 renderer: one Blinn-Phong program, unit meshes scaled per part (or
//! the arm's own link meshes), planar projected shadows on the desk, a grid and
//! an end-effector trail. While the real arm follows the simulation, the real
//! arm is drawn solid and the simulation's pose as a translucent ghost.

pub mod camera;
pub mod mesh;
pub mod scene;

use glam::{Mat3, Mat4, Quat, Vec3};
use wasm_bindgen::{JsCast, JsValue};
use web_sys::{HtmlCanvasElement, WebGl2RenderingContext as GL, WebGlProgram, WebGlShader, WebGlUniformLocation};

use crate::arm::{Arm, NUM_JOINTS};
use crate::world::World;
use camera::OrbitCamera;
use mesh::GpuMesh;
use scene::{Color, Shape, LINK_MESHES};

const BACKGROUND: Color = [0.465, 0.465, 0.465, 1.0];
const GROUND: Color = [0.32, 0.32, 0.325, 1.0];
const SHADOW: Color = [0.025, 0.028, 0.032, 0.68];
const TRAIL: Color = [0.12, 0.47, 0.71, 1.0];
const GHOST: Color = [0.7, 0.73, 0.76, 0.32];
const GHOST_MIN_GAP: f32 = 0.009;
const LIGHT_DIR: Vec3 = Vec3::new(-0.65, 1.0, -0.45);

#[derive(Clone, Copy)]
enum Surface { Flat, Lit, Floor }

const VERTEX_SHADER: &str = r#"#version 300 es
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
uniform mat4 u_viewproj;
uniform mat4 u_model;
uniform mat3 u_normal_mat;
out vec3 v_normal;
out vec3 v_world;
void main() {
    vec4 w = u_model * vec4(a_pos, 1.0);
    v_world = w.xyz;
    v_normal = u_normal_mat * a_normal;
    gl_Position = u_viewproj * w;
}
"#;

const FRAGMENT_SHADER: &str = r#"#version 300 es
precision highp float;
in vec3 v_normal;
in vec3 v_world;
uniform vec4 u_color;
uniform vec3 u_light_dir;
uniform vec3 u_eye;
uniform vec3 u_fog;
uniform float u_lit;
out vec4 o_color;
void main() {
    vec3 col = u_color.rgb;
    if (u_lit > 1.5) {
        // Ten-centimetre cells; smooth edges and fade distant subpixel lines.
        vec2 cell = v_world.xz / 0.10;
        vec2 fw = max(fwidth(cell), vec2(0.0001));
        vec2 edge = abs(fract(cell + 0.5) - 0.5);
        vec2 line = (1.0 - smoothstep(vec2(0.005), vec2(0.005) + fw, edge))
                  * (1.0 - smoothstep(vec2(0.10), vec2(0.50), fw));
        col += vec3(0.095 * max(line.x, line.y));
    } else if (u_lit > 0.5) {
        vec3 albedo = pow(col, vec3(2.2));
        vec3 n = normalize(v_normal);
        vec3 l = normalize(u_light_dir);
        vec3 v = normalize(u_eye - v_world);
        vec3 h = normalize(l + v);
        float diff = max(dot(n, l), 0.0);
        float spec = pow(max(dot(n, h), 0.0), 48.0) * 0.25;
        float hemi = 0.5 + 0.5 * n.y;
        vec3 ambient = albedo * mix(vec3(0.11, 0.11, 0.12), vec3(0.32, 0.34, 0.36), hemi);
        col = pow(ambient + albedo * diff * 0.9 + vec3(spec), vec3(1.0 / 2.2));
    }
    float d = length(u_eye - v_world);
    col = mix(col, u_fog, clamp((d - 1.5) / 4.0, 0.0, 1.0));
    o_color = vec4(col, u_color.a);
}
"#;

struct Uniforms {
    viewproj: WebGlUniformLocation,
    model: WebGlUniformLocation,
    normal_mat: WebGlUniformLocation,
    color: WebGlUniformLocation,
    light_dir: WebGlUniformLocation,
    eye: WebGlUniformLocation,
    fog: WebGlUniformLocation,
    lit: WebGlUniformLocation,
}

pub struct Renderer {
    gl: GL,
    canvas: HtmlCanvasElement,
    program: WebGlProgram,
    u: Uniforms,
    cube: GpuMesh,
    cylinder: GpuMesh,
    cone: GpuMesh,
    pub reference: Option<Mat4>,
    /// Waveshare's link meshes (scene::LINK_MESHES), once the page has loaded them.
    links: [Option<GpuMesh>; LINK_MESHES.len()],
    trail: GpuMesh,
    trail_data: Vec<f32>,
}

impl Renderer {
    pub fn new(canvas: HtmlCanvasElement) -> Result<Self, JsValue> {
        let opts = js_sys::Object::new();
        for name in ["antialias", "stencil"] {
            js_sys::Reflect::set(&opts, &name.into(), &true.into())?;
        }
        let gl: GL = canvas
            .get_context_with_context_options("webgl2", &opts)?
            .ok_or("WebGL2 is not supported by this browser")?
            .dyn_into()?;

        let program = link_program(&gl, VERTEX_SHADER, FRAGMENT_SHADER)?;
        let loc = |name: &str| {
            gl.get_uniform_location(&program, name)
                .ok_or_else(|| JsValue::from_str(&format!("missing uniform {name}")))
        };
        let u = Uniforms {
            viewproj: loc("u_viewproj")?,
            model: loc("u_model")?,
            normal_mat: loc("u_normal_mat")?,
            color: loc("u_color")?,
            light_dir: loc("u_light_dir")?,
            eye: loc("u_eye")?,
            fog: loc("u_fog")?,
            lit: loc("u_lit")?,
        };

        let cube = GpuMesh::new(&gl, &mesh::cube(), GL::TRIANGLES, false)?;
        let cylinder = GpuMesh::new(&gl, &mesh::cylinder(32), GL::TRIANGLES, false)?;
        let cone = GpuMesh::new(&gl, &mesh::arrowhead(16), GL::TRIANGLES, false)?;
        let trail = GpuMesh::new(&gl, &[], GL::TRIANGLE_STRIP, true)?;

        let links = Default::default();
        Ok(Self { gl, canvas, program, u, cube, cylinder, cone, reference: None, links, trail, trail_data: Vec::new() })
    }

    /// Binary STL for link `i` of scene::LINK_MESHES (in metres, in that link's frame).
    pub fn load_link(&mut self, i: usize, bytes: &[u8]) -> Result<(), JsValue> {
        let slot = self.links.get_mut(i).ok_or("no such link")?;
        *slot = Some(GpuMesh::new(&self.gl, &mesh::stl(bytes)?, GL::TRIANGLES, false)?);
        Ok(())
    }

    fn meshes_ready(&self) -> bool {
        self.links.iter().all(Option::is_some)
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.canvas.set_width(width.max(1));
        self.canvas.set_height(height.max(1));
    }

    /// `sim`: the simulated arm. `real`: the real arm's pose, drawn solid in its
    /// place, with `sim` as a ghost where they differ.
    pub fn render(&mut self, cam: &OrbitCamera, sim: &Arm, real: Option<&Arm>, world: &World, trail: &[Vec3]) {
        let arm = real.unwrap_or(sim);
        let ghost = real.filter(|r| (0..NUM_JOINTS).any(|j| (r.angle(j) - sim.angle(j)).abs() > GHOST_MIN_GAP)).map(|_| sim);
        let eye = cam.eye();
        self.trail_data.clear();
        // A camera-facing ribbon stays readable on implementations limited to 1px GL lines.
        for (i, &p) in trail.iter().enumerate() {
            let tangent = trail[(i + 1).min(trail.len() - 1)] - trail[i.saturating_sub(1)];
            let offset = tangent.cross(eye - p).normalize_or_zero() * 0.00115;
            for v in [p - offset, p + offset] {
                self.trail_data.extend_from_slice(&[v.x, v.y, v.z, 0.0, 1.0, 0.0]);
            }
        }
        self.trail.update(&self.gl, &self.trail_data);

        let gl = &self.gl;
        let (w, h) = (self.canvas.width() as i32, self.canvas.height() as i32);
        gl.viewport(0, 0, w, h);
        let [r, g, b, a] = BACKGROUND;
        gl.clear_color(r, g, b, a);
        gl.clear(GL::COLOR_BUFFER_BIT | GL::DEPTH_BUFFER_BIT | GL::STENCIL_BUFFER_BIT);
        gl.enable(GL::DEPTH_TEST);
        gl.depth_func(GL::LESS);
        gl.use_program(Some(&self.program));

        let viewproj = cam.proj(w as f32 / h.max(1) as f32) * cam.view();
        gl.uniform_matrix4fv_with_f32_array(Some(&self.u.viewproj), false, &viewproj.to_cols_array());
        gl.uniform3fv_with_f32_array(Some(&self.u.light_dir), &LIGHT_DIR.normalize().to_array());
        gl.uniform3fv_with_f32_array(Some(&self.u.eye), &eye.to_array());
        gl.uniform3f(Some(&self.u.fog), r, g, b);

        // desk slab (top face at y = 0) and its grid
        let ground = Mat4::from_scale_rotation_translation(Vec3::new(36.0, 0.02, 36.0), Quat::IDENTITY, Vec3::Y * -0.01);
        self.draw(&self.cube, ground, GROUND, Surface::Floor);

        // Composite each projected shadow pixel once, including overlapping STL facets.
        let mut parts = scene::arm_parts(arm, self.meshes_ready());
        // the box belongs to the simulation, so it rides in the simulated gripper
        parts.extend(scene::world_parts(world, sim.frames().tool));
        let onto_desk = shadow_matrix(LIGHT_DIR, Vec3::Y, 0.00025);
        gl.enable(GL::STENCIL_TEST);
        gl.stencil_func(GL::EQUAL, 0, 0xff);
        gl.stencil_op(GL::KEEP, GL::KEEP, GL::INCR);
        gl.enable(GL::BLEND);
        gl.blend_func(GL::SRC_ALPHA, GL::ONE_MINUS_SRC_ALPHA);
        for p in &parts {
            self.draw(self.mesh(p.shape), onto_desk * p.model, SHADOW, Surface::Flat);
        }
        gl.disable(GL::BLEND);
        gl.disable(GL::STENCIL_TEST);

        for p in &parts {
            self.draw(self.mesh(p.shape), p.model, p.color, Surface::Lit);
        }

        if self.trail.count >= 4 {
            self.draw(&self.trail, Mat4::IDENTITY, TRAIL, Surface::Flat);
        }

        if let Some(reference) = self.reference {
            self.tool_axes(reference, 0.064, true);
        }
        self.tool_axes(sim.frames().tool, 0.052, false);

        if let Some(ghost) = ghost {
            // Depth first, then colour where it matches, so only the ghost's
            // nearest surface is tinted (no darker overlaps inside it).
            let parts = scene::arm_parts(ghost, self.meshes_ready());
            gl.color_mask(false, false, false, false);
            for p in &parts {
                self.draw(self.mesh(p.shape), p.model, GHOST, Surface::Flat);
            }
            gl.color_mask(true, true, true, true);
            gl.depth_func(GL::LEQUAL);
            gl.depth_mask(false);
            gl.enable(GL::BLEND);
            for p in &parts {
                self.draw(self.mesh(p.shape), p.model, GHOST, Surface::Lit);
            }
            gl.disable(GL::BLEND);
            gl.depth_mask(true);
        }
    }

    fn tool_axes(&self, pose: Mat4, length: f32, reference: bool) {
        for (axis, rgb) in [(Vec3::X, [0.92, 0.18, 0.14, 1.0]),
                            (Vec3::Y, [0.18, 0.76, 0.24, 1.0]),
                            (Vec3::Z, [0.14, 0.39, 1.0, 1.0])] {
            let color = if reference { [0.79, 0.79, 0.79, 1.0] } else { rgb };
            let basis = pose * Mat4::from_quat(Quat::from_rotation_arc(Vec3::Y, axis));
            let part = |center, diameter, height| basis * Mat4::from_translation(Vec3::Y * center)
                * Mat4::from_scale(Vec3::new(diameter, height, diameter));
            self.draw(&self.cylinder, part(length*0.4, 0.0016, length*0.8), color, Surface::Flat);
            self.draw(&self.cone, part(length*0.9, 0.005, length*0.2), color, Surface::Flat);
        }
    }

    fn mesh(&self, shape: Shape) -> &GpuMesh {
        match shape {
            Shape::Cube => &self.cube,
            Shape::Cylinder => &self.cylinder,
            Shape::Link(i) => self.links[i].as_ref().unwrap_or(&self.cube),
        }
    }

    fn draw(&self, mesh: &GpuMesh, model: Mat4, color: Color, surface: Surface) {
        let gl = &self.gl;
        let normal_mat = if matches!(surface, Surface::Lit) { Mat3::from_mat4(model).inverse().transpose() } else { Mat3::IDENTITY };
        gl.uniform_matrix4fv_with_f32_array(Some(&self.u.model), false, &model.to_cols_array());
        gl.uniform_matrix3fv_with_f32_array(Some(&self.u.normal_mat), false, &normal_mat.to_cols_array());
        gl.uniform4fv_with_f32_array(Some(&self.u.color), &color);
        gl.uniform1f(Some(&self.u.lit), match surface { Surface::Flat => 0.0, Surface::Lit => 1.0, Surface::Floor => 2.0 });
        gl.bind_vertex_array(Some(&mesh.vao));
        gl.draw_arrays(mesh.mode, 0, mesh.count);
    }
}

/// Projects points along `light` (direction towards the light) onto the plane
/// `normal · p = d`: p' = p − light · (normal · p − d) / (normal · light).
fn shadow_matrix(light: Vec3, normal: Vec3, d: f32) -> Mat4 {
    let k = normal.dot(light);
    Mat4::from_cols(
        (Vec3::X - light * (normal.x / k)).extend(0.0),
        (Vec3::Y - light * (normal.y / k)).extend(0.0),
        (Vec3::Z - light * (normal.z / k)).extend(0.0),
        (light * (d / k)).extend(1.0),
    )
}

fn compile(gl: &GL, kind: u32, src: &str) -> Result<WebGlShader, JsValue> {
    let shader = gl.create_shader(kind).ok_or("create_shader failed")?;
    gl.shader_source(&shader, src);
    gl.compile_shader(&shader);
    if gl.get_shader_parameter(&shader, GL::COMPILE_STATUS).as_bool().unwrap_or(false) {
        Ok(shader)
    } else {
        Err(gl.get_shader_info_log(&shader).unwrap_or_default().into())
    }
}

fn link_program(gl: &GL, vs: &str, fs: &str) -> Result<WebGlProgram, JsValue> {
    let program = gl.create_program().ok_or("create_program failed")?;
    gl.attach_shader(&program, &compile(gl, GL::VERTEX_SHADER, vs)?);
    gl.attach_shader(&program, &compile(gl, GL::FRAGMENT_SHADER, fs)?);
    gl.link_program(&program);
    if gl.get_program_parameter(&program, GL::LINK_STATUS).as_bool().unwrap_or(false) {
        Ok(program)
    } else {
        Err(gl.get_program_info_log(&program).unwrap_or_default().into())
    }
}
