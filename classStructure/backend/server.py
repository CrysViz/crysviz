# server.py
from flask import Flask
from flask_socketio import SocketIO, emit
import time
import spglib

from httk_symgen.utils.symmetry import Spacegroup
from httk_symgen.utils.crystal import *
from httk_symgen.structure_generator  import StructureSolver
from ase.optimize import BFGS
from ase.filters import FrechetCellFilter
from mace.calculators import mace_mp
from ase.io import read 

calc = mace_mp(model="mace-mpa-0-medium.model", dispersion=False, default_dtype="float64", device='cpu')
from ase import  Atoms


app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

@socketio.on("getSpacegroup")
def getSpacegroup(data):
    print("received data")

    positions= data.get("positions",0)
    lattice= data.get("lattice",1)
    elements= data.get("elements",2)

    # Send status updates during fake 5 second processing

    struc = StructureRepr_from_dict({"lattice": lattice, "elements":elements, "fractional_coordinates":positions})
    solver = StructureSolver.from_protostructure_ID(StructureSolver_input_from_StructureRepr(struc)[0])
    spg = Spacegroup(solver.spgp)

    olist = solver.orbitlist
    print(olist)
    string=""
    for orbit in olist: 
      string+= f"{orbit.multiplicity}{orbit.wp_letter} "

    
    print(f"{spg=}")
    print(f"{string}")

    result = f"{spg.symbol} ({spg.number}), {string}"

    print(f"{result}")
    emit("result", {"result": result})


@socketio.on("relaxStructure")
def relaxStructure(data):
  positions= data.get("positions",-1)
  lattice= data.get("lattice",-1)
  elements= data.get("elements",-1)
  fmax=data.get("fmax",0.001)
  pressure=data.get("pressure",0)

  print(f"{pressure=}")
  print(f"{fmax=}")
  
  optimization_steps=[]

  struc = Atoms(cell=lattice, symbols=elements, scaled_positions = positions,pbc=True)
  struc.calc = calc
  def store_step():
    optimization_steps.append(struc.copy())

  ecf = FrechetCellFilter(struc, hydrostatic_strain=False, scalar_pressure=pressure)
  opt = BFGS(ecf)
  opt.attach(store_step, 1)
  opt.run(fmax=fmax)

  lattices=[]
  positions=[]

  for atoms in optimization_steps:
    lattices.append(atoms.cell.array.tolist())
    positions.append(atoms.get_scaled_positions().tolist())

  
  result={"lattices":lattices,"positions":positions,"numSteps": len(lattices), "log":"Calculation converged"}
  emit("result", {"result": result})
  
    
    
if __name__ == "__main__":
    socketio.run(app, port=5001)

