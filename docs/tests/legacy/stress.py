import numpy as np
import matplotlib
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D  # noqa: F401

# ---- Define your symmetric Cauchy stress tensor (MPa) ----
sigma = np.array([[50.0, 10.0, 5.0],
                  [10.0,-30.0, 0.0],
                  [ 5.0,  0.0,20.0]], dtype=float)

# ---- Eigen decomposition (principal stresses/directions) ----
w, V = np.linalg.eigh(sigma)  # eigenvalues (σ), eigenvectors (columns)

# Sort by descending |principal stress|
idx = np.argsort(np.abs(w))[::-1]
w = w[idx]
V = V[:, idx]

# ---- Ellipsoid parameters ----
absw = np.abs(w)
maxw = absw.max() if absw.max() > 0 else 1.0
axes = absw / maxw  # normalized semi-axis lengths (largest = 1)

# Parameterize ellipsoid
nu, nv = 100, 100
u_vals = np.linspace(0, 2*np.pi, nu)
v_vals = np.linspace(0, np.pi, nv)
U, Vv = np.meshgrid(u_vals, v_vals)

# Ellipsoid aligned with principal axes
xp = axes[0] * np.sin(Vv) * np.cos(U)
yp = axes[1] * np.sin(Vv) * np.sin(U)
zp = axes[2] * np.cos(Vv)

# Rotate to lab frame by V
P = np.vstack([xp.ravel(), yp.ravel(), zp.ravel()])
Prot = V @ P
X = Prot[0, :].reshape(xp.shape)
Y = Prot[1, :].reshape(yp.shape)
Z = Prot[2, :].reshape(zp.shape)

# ---- Plot ----
fig = plt.figure(figsize=(8, 8))
ax = fig.add_subplot(111, projection='3d')

# Ellipsoid surface
ax.plot_surface(X, Y, Z, rstride=4, cstride=4, color='#6baed6', alpha=0.25, edgecolor='none')

# Principal stress arrows
arrow_scale = 1.2
colors = ['#d73027' if s >= 0 else '#4575b4' for s in w]  # red=tension, blue=compression
for i in range(3):
    direction = V[:, i]
    length = (absw[i] / maxw) * arrow_scale
    ax.quiver(0, 0, 0, *(direction * length), color=colors[i], linewidth=2, arrow_length_ratio=0.08)
    ax.quiver(0, 0, 0, *(-direction * length), color=colors[i], linewidth=2, arrow_length_ratio=0.08)
    ax.plot([ -direction[0]*length, direction[0]*length],
            [ -direction[1]*length, direction[1]*length],
            [ -direction[2]*length, direction[2]*length],
            color=colors[i], alpha=0.5, linewidth=1.0)

# Invariants
I1 = np.trace(sigma)
p = I1 / 3.0
I = np.eye(3)
s_dev = sigma - p * I
J2 = 0.5 * np.sum(s_dev * s_dev)
vm = np.sqrt(3.0 * J2)

# Text box
text = (
    f"Principal stresses (MPa):\n"
    f"  σ1 = {w[0]: .3f}\n  σ2 = {w[1]: .3f}\n  σ3 = {w[2]: .3f}\n\n"
    f"Invariants:\n  I1 (trace) = {I1: .3f}\n  J2(dev) = {J2: .3f}\n  von Mises = {vm: .3f}"
)
ax.text2D(0.02, 0.02, text, transform=ax.transAxes, fontsize=10, family='monospace')

# Axes cosmetics
max_range = np.array([X.max()-X.min(), Y.max()-Y.min(), Z.max()-Z.min()]).max()
mid_x = (X.max()+X.min()) * 0.5
mid_y = (Y.max()+Y.min()) * 0.5
mid_z = (Z.max()+Z.min()) * 0.5
ax.set_xlim(mid_x - max_range/2, mid_x + max_range/2)
ax.set_ylim(mid_y - max_range/2, mid_y + max_range/2)
ax.set_zlim(mid_z - max_range/2, mid_z + max_range/2)
ax.set_box_aspect([1,1,1])

ax.set_xlabel('x'); ax.set_ylabel('y'); ax.set_zlabel('z')
ax.set_title('Stress Ellipsoid with Principal Stress Arrows')
ax.scatter([0],[0],[0], color='k', s=10)

plt.tight_layout()
plt.show()

